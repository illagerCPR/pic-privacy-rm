import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PipelineClient } from '../lib/pipeline-client.ts';
import type { MetadataReport } from '../core/metadata.ts';
import type { RemovalEntry, ScanResult, StripOptions, VerifyResult } from '../core/types.ts';
import { DEFAULT_STRIP_OPTIONS } from '../core/types.ts';
import { bakeIfNeeded } from '../lib/bake.ts';
import { isPipelineError } from '../core/errors.ts';
import { createToken, runBatch, type BatchToken } from '../lib/batch.ts';
import { archiveName, downloadBlob } from '../lib/download.ts';
import { buildZip, type ZipEntry } from '../lib/zip.ts';
import {
  batchReportName,
  buildBatchReport,
  buildReport,
  reportFileName,
  type ReportInput,
} from '../lib/report.ts';
import {
  looksLikeImage,
  outputName,
  safeArchivePath,
  sortIncoming,
  uniqueName,
  type IncomingFile,
} from '../lib/files.ts';
import { createLimiter } from '../lib/queue.ts';

export type ItemState =
  'scanning' | 'ready' | 'clean' | 'unsupported' | 'error' | 'stripping' | 'done' | 'failed';

export interface ItemResult {
  blob: Blob;
  filename: string;
  size: number;
  removed: RemovalEntry[];
  removedBytes: number;
  verify: VerifyResult;
  reencoded: boolean;
  /** True when the requested orientation bake failed; the strip itself succeeded. */
  bakeFailed?: boolean;
}

export interface Item {
  id: string;
  file: File;
  name: string;
  /** Folder inside the drop, kept so the archive mirrors what was handed in. */
  relPath?: string;
  size: number;
  previewUrl: string;
  state: ItemState;
  scan?: ScanResult;
  error?: string;
  result?: ItemResult;
}

export interface NotifyFn {
  (key: string, params?: Record<string, string | number>): void;
}

/** A long job that reports movement while it runs outside the strip queue. */
export interface JobProgress {
  kind: 'zip' | 'report';
  done: number;
  total: number;
}

interface Settings {
  options: StripOptions;
  bake: boolean;
  /** Redact sensitive values in exported reports; on unless the user opts out. */
  redactReports: boolean;
}

const SETTINGS_KEY = 'picprivacy.settings';
/** Full metadata listings are large; keep the last few instead of every file. */
const INSPECT_CACHE_LIMIT = 16;

function loadSettings(): Settings {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Settings>;
      return {
        options: {
          truncateTrailer: parsed.options?.truncateTrailer ?? DEFAULT_STRIP_OPTIONS.truncateTrailer,
          keepIcc: parsed.options?.keepIcc ?? DEFAULT_STRIP_OPTIONS.keepIcc,
        },
        bake: parsed.bake ?? false,
        redactReports: parsed.redactReports ?? true,
      };
    }
  } catch {
    /* ignore */
  }
  return { options: DEFAULT_STRIP_OPTIONS, bake: false, redactReports: true };
}

function makeId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `item-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isImageLike(file: File): boolean {
  return file.type.startsWith('image/') || looksLikeImage(file);
}

function isSensitive(scan: ScanResult): boolean {
  return scan.droppedBytes > 0 || scan.findings.some((f) => f.category !== 'icc');
}

/** The only two states that may produce a download. */
export type DownloadSource = 'result' | 'passthrough' | null;

/**
 * Decide whether an item may be downloaded. "done" means the strip was
 * re-scanned and passed, "clean" means the input was already free of metadata.
 * A failed item keeps its result for the diagnostic report, but it must never
 * reach the archive: exporting unverified bytes is exactly what the project
 * promises not to do.
 */
export function downloadableState(item: Item): DownloadSource {
  if (item.state === 'done' && item.result) return 'result';
  if (item.state === 'clean') return 'passthrough';
  return null;
}

/** Map an engine error to a user-facing i18n key instead of leaking its message. */
function errorKey(error: unknown): string {
  if (isPipelineError(error)) {
    if (error.code === 'unsupported-format') return 'error.unsupported';
    if (error.code === 'unreadable') return 'error.unreadable';
    if (error.code === 'worker-crashed' || error.code === 'worker-timeout') return 'error.worker';
    return 'error.stripFailed';
  }
  return 'error.stripFailed';
}

export interface Workspace {
  items: Item[];
  addFiles: (files: IncomingFile[]) => void;
  removeItem: (id: string) => void;
  clear: () => void;
  stripItem: (id: string) => Promise<void>;
  stripAll: () => Promise<void>;
  downloadItem: (id: string) => Promise<void>;
  downloadAll: () => Promise<void>;
  /** Write a reproducible JSON report of what the engine saw and did. */
  exportReport: (id: string) => Promise<void>;
  /** The same for every file that has a scan, as one document. */
  exportBatchReport: () => Promise<void>;
  /** Full metadata listing, parsed lazily and cached per item. */
  inspectItem: (id: string) => Promise<MetadataReport | null>;
  /** The same listing for the stripped output, used by the before/after view. */
  inspectResult: (id: string) => Promise<MetadataReport | null>;
  options: StripOptions;
  setOptions: (patch: Partial<StripOptions>) => void;
  bake: boolean;
  setBake: (value: boolean) => void;
  redactReports: boolean;
  setRedactReports: (value: boolean) => void;
  busy: boolean;
  progress: { done: number; total: number } | null;
  /** How many scans in the current add batch have finished. */
  scanProgress: { done: number; total: number } | null;
  /** Packaging or report building in flight, null when idle. */
  job: JobProgress | null;
  /** True once a batch has been asked to stop but a file is still finishing. */
  cancelling: boolean;
  cancelBatch: () => void;
}

export function useWorkspace(pipeline: PipelineClient, notify: NotifyFn): Workspace {
  const [items, setItems] = useState<Item[]>([]);
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [scanProgress, setScanProgress] = useState<{ done: number; total: number } | null>(null);
  const [batchRunning, setBatchRunning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [job, setJob] = useState<JobProgress | null>(null);
  const batchRef = useRef<BatchToken | null>(null);
  const jobRef = useRef(false);
  const itemsRef = useRef<Item[]>([]);
  const scanTotalRef = useRef(0);
  const scanDoneRef = useRef(0);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const scanLimit = useMemo(() => createLimiter(2), []);
  // Strips run one at a time: deterministic, memory-flat, and fast enough
  // (the work is a single pass over the container).
  const stripLimit = useMemo(() => createLimiter(1), []);

  // The full listing is far more expensive than a scan, so it is built only
  // when the metadata tab is actually opened, then kept for the item's lifetime.
  // Keys carry a `:src` / `:out` suffix so the source and the stripped copy do
  // not collide.
  const inspectCache = useRef(new Map<string, MetadataReport>());
  const inspectPending = useRef(new Map<string, Promise<MetadataReport>>());

  const updateItems = useCallback((updater: (prev: Item[]) => Item[]) => {
    const next = updater(itemsRef.current);
    itemsRef.current = next;
    setItems(next);
  }, []);

  const patchItem = useCallback(
    (id: string, patch: Partial<Item>) => {
      updateItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
    },
    [updateItems],
  );

  useEffect(() => {
    try {
      window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      /* ignore */
    }
  }, [settings]);

  useEffect(
    () => () => {
      for (const item of itemsRef.current) URL.revokeObjectURL(item.previewUrl);
    },
    [],
  );

  const scanOne = useCallback(
    async (item: Item) => {
      try {
        const scan = await scanLimit(() => pipeline.scan(item.file));
        // A container the parser rejects is not "clean": saying so would offer a
        // download of a file we never actually read.
        const broken = scan.warnings.find((warning) => warning.severity === 'error');
        patchItem(item.id, {
          scan,
          state: !scan.supported
            ? 'unsupported'
            : broken
              ? 'failed'
              : isSensitive(scan)
                ? 'ready'
                : 'clean',
          error: broken ? broken.id : undefined,
        });
      } catch (error) {
        patchItem(item.id, { state: 'error', error: errorKey(error) });
      } finally {
        scanDoneRef.current += 1;
        if (scanTotalRef.current > 0 && scanDoneRef.current >= scanTotalRef.current) {
          scanDoneRef.current = 0;
          scanTotalRef.current = 0;
          setScanProgress(null);
        } else if (scanTotalRef.current > 0) {
          setScanProgress({ done: scanDoneRef.current, total: scanTotalRef.current });
        } else {
          // The list was cleared while this scan was in flight.
          scanDoneRef.current = 0;
        }
      }
    },
    [patchItem, pipeline, scanLimit],
  );

  const addFiles = useCallback(
    (files: IncomingFile[]) => {
      const accepted = files.filter((entry) => isImageLike(entry.file));
      const skipped = files.length - accepted.length;
      if (accepted.length === 0) {
        if (skipped > 0) notify('toast.skipped', { n: skipped });
        return;
      }
      const sorted = sortIncoming(accepted);
      const created: Item[] = sorted.map((entry) => ({
        id: makeId(),
        file: entry.file,
        name: entry.file.name,
        relPath: entry.dir === '' ? undefined : entry.dir,
        size: entry.file.size,
        previewUrl: URL.createObjectURL(entry.file),
        state: 'scanning',
      }));
      updateItems((prev) => [...prev, ...created]);
      notify('toast.added', { n: created.length });
      if (skipped > 0) notify('toast.skipped', { n: skipped });
      scanTotalRef.current += created.length;
      setScanProgress({ done: scanDoneRef.current, total: scanTotalRef.current });
      for (const item of created) void scanOne(item);
    },
    [notify, scanOne, updateItems],
  );

  const removeItem = useCallback(
    (id: string) => {
      inspectCache.current.delete(`${id}:src`);
      inspectCache.current.delete(`${id}:out`);
      updateItems((prev) => {
        const target = prev.find((item) => item.id === id);
        if (target) URL.revokeObjectURL(target.previewUrl);
        return prev.filter((item) => item.id !== id);
      });
    },
    [updateItems],
  );

  const clear = useCallback(() => {
    inspectCache.current.clear();
    inspectPending.current.clear();
    updateItems((prev) => {
      for (const item of prev) URL.revokeObjectURL(item.previewUrl);
      return [];
    });
    setProgress(null);
    scanDoneRef.current = 0;
    scanTotalRef.current = 0;
    setScanProgress(null);
  }, [updateItems]);

  const runInspect = useCallback(
    async (id: string, side: 'src' | 'out'): Promise<MetadataReport | null> => {
      const key = `${id}:${side}`;
      const cached = inspectCache.current.get(key);
      if (cached) {
        // Refresh insertion order so the least recently used entry is evicted.
        inspectCache.current.delete(key);
        inspectCache.current.set(key, cached);
        return cached;
      }
      const inFlight = inspectPending.current.get(key);
      if (inFlight) return inFlight;

      const item = itemsRef.current.find((entry) => entry.id === id);
      if (!item || item.scan?.supported === false) return null;
      const blob = side === 'src' ? item.file : item.result?.blob;
      if (!blob) return null;

      const task = pipeline
        .inspect(blob, { keepIcc: settingsRef.current.options.keepIcc })
        .then((report) => {
          inspectCache.current.set(key, report);
          while (inspectCache.current.size > INSPECT_CACHE_LIMIT) {
            const oldest = inspectCache.current.keys().next().value;
            if (oldest === undefined) break;
            inspectCache.current.delete(oldest);
          }
          return report;
        })
        .finally(() => {
          inspectPending.current.delete(key);
        });
      inspectPending.current.set(key, task);
      return task;
    },
    [pipeline],
  );

  const inspectItem = useCallback((id: string) => runInspect(id, 'src'), [runInspect]);
  const inspectResult = useCallback((id: string) => runInspect(id, 'out'), [runInspect]);

  const stripOne = useCallback(
    async (item: Item, token?: BatchToken): Promise<boolean> => {
      try {
        const outcome = await stripLimit(async () => {
          // Cancellation is checked once the limiter hands us a slot: before
          // that, every queued item looks at a token nobody has set yet.
          if (token?.cancelled) return null;
          patchItem(item.id, { state: 'stripping', error: undefined });
          return pipeline.strip(item.file, settingsRef.current.options);
        });
        // Cancelled while queued: leave the row exactly as it was.
        if (!outcome) return false;
        let { blob } = outcome.result;
        let mime = outcome.result.mime;
        let ext = outcome.result.ext;
        let verify = outcome.verify;

        const orientation = item.scan?.orientation ?? 1;
        const baked = await bakeIfNeeded(blob, mime, ext, orientation, settingsRef.current.bake);
        blob = baked.blob;
        mime = baked.mime;
        ext = baked.ext;
        if (baked.reencoded) verify = await pipeline.verify(blob);

        const result: ItemResult = {
          blob,
          filename: outputName(item.name, ext),
          size: blob.size,
          removed: outcome.result.removed,
          removedBytes: outcome.result.removedBytes,
          verify,
          reencoded: baked.reencoded,
          bakeFailed: baked.failed,
        };

        inspectCache.current.delete(`${item.id}:out`);
        if (!verify.ok) {
          patchItem(item.id, { state: 'failed', error: 'error.verifyFailed', result });
          return true;
        }
        patchItem(item.id, { state: 'done', result });
        return true;
      } catch (error) {
        patchItem(item.id, { state: 'failed', error: errorKey(error) });
        return true;
      }
    },
    [patchItem, pipeline, stripLimit],
  );

  const stripItem = useCallback(
    async (id: string) => {
      const item = itemsRef.current.find((entry) => entry.id === id);
      if (!item || item.state === 'stripping' || !item.scan?.supported) return;
      await stripOne(item);
    },
    [stripOne],
  );

  const stripAll = useCallback(async () => {
    // A file the parser already rejected cannot be cleaned by retrying it: the
    // strip pass would throw on the same structure and the batch would waste a
    // slot. A verified failure is retried, because the settings may have changed.
    const targets = itemsRef.current.filter(
      (item) =>
        item.state === 'ready' ||
        (item.state === 'failed' &&
          item.scan?.supported === true &&
          !item.scan.warnings.some((warning) => warning.severity === 'error')),
    );
    if (targets.length === 0) return;
    const token = createToken();
    batchRef.current = token;
    setBatchRunning(true);
    setCancelling(false);
    setProgress({ done: 0, total: targets.length });
    // stripOne() goes through the shared limiter itself; do not nest another one
    // (two outer holders would each wait for an inner slot and deadlock).
    const outcome = await runBatch(
      targets,
      (item, batchToken) => stripOne(item, batchToken),
      token,
      (next) => setProgress(next),
    );
    batchRef.current = null;
    setBatchRunning(false);
    setCancelling(false);
    setProgress(null);
    if (token.cancelled) {
      notify('toast.batchCancelled', { n: outcome.done, left: outcome.skipped });
      return;
    }
    const finished = targets.filter(
      (target) => itemsRef.current.find((item) => item.id === target.id)?.state === 'done',
    ).length;
    notify('toast.done', { n: finished });
    // The default path drops the orientation tag; say so instead of leaving the
    // user to discover a sideways photo in their gallery.
    const sideways = targets.filter((target) => {
      const item = itemsRef.current.find((entry) => entry.id === target.id);
      return (
        item?.state === 'done' && !settingsRef.current.bake && (item.scan?.orientation ?? 1) > 1
      );
    }).length;
    if (sideways > 0) notify('toast.orientationLost', { n: sideways });
  }, [notify, stripOne]);

  /**
   * Stop the queue, not the file already in flight: that one finishes and is
   * still verified, because a half-cleaned row would be a lie either way.
   */
  const cancelBatch = useCallback(() => {
    const token = batchRef.current;
    if (!token || token.cancelled) return;
    token.cancelled = true;
    setCancelling(true);
    notify('toast.cancelRequested');
  }, [notify]);

  /** A clean file still gets a downloadable copy, byte-identical to the input. */
  const passthroughResult = useCallback((item: Item): ItemResult => {
    const scan = item.scan;
    return {
      blob: item.file,
      filename: outputName(item.name, scan?.format === 'jpeg' ? 'jpg' : (scan?.format ?? 'bin')),
      size: item.file.size,
      removed: [],
      removedBytes: 0,
      verify: { ok: true, leftovers: [], warnings: scan?.warnings ?? [], fileSize: item.file.size },
      reencoded: false,
    };
  }, []);

  const exportReport = useCallback(
    async (id: string) => {
      const item = itemsRef.current.find((entry) => entry.id === id);
      if (!item?.scan) return;
      const json = await buildReport({
        file: item.file,
        scan: item.scan,
        options: settingsRef.current.options,
        bake: settingsRef.current.bake,
        redact: settingsRef.current.redactReports,
        result: item.result
          ? {
              size: item.result.size,
              filename: item.result.filename,
              removed: item.result.removed,
              removedBytes: item.result.removedBytes,
              reencoded: item.result.reencoded,
              bakeFailed: item.result.bakeFailed ?? false,
              verify: item.result.verify,
            }
          : undefined,
      });
      downloadBlob(new Blob([json], { type: 'application/json' }), reportFileName(item.name));
      notify('toast.report');
    },
    [notify],
  );

  const downloadItem = useCallback(
    async (id: string) => {
      const item = itemsRef.current.find((entry) => entry.id === id);
      if (!item) return;
      const source = downloadableState(item);
      const result =
        source === 'result'
          ? item.result
          : source === 'passthrough'
            ? passthroughResult(item)
            : undefined;
      if (!result) return;
      downloadBlob(result.blob, result.filename);
    },
    [passthroughResult],
  );

  const downloadAll = useCallback(async () => {
    if (jobRef.current) return;
    const ready: ZipEntry[] = [];
    const taken = new Set<string>();
    for (const item of itemsRef.current) {
      const source = downloadableState(item);
      const result =
        source === 'result'
          ? item.result
          : source === 'passthrough'
            ? passthroughResult(item)
            : undefined;
      if (!result) continue;
      // The folder the photo came from is part of its identity: a shoot dumped
      // into one flat pile loses the selection and shooting order.
      ready.push({
        name: uniqueName(safeArchivePath(item.relPath ?? '', result.filename), taken),
        blob: result.blob,
      });
    }
    if (ready.length === 0) {
      notify('error.noFiles');
      return;
    }
    jobRef.current = true;
    setJob({ kind: 'zip', done: 0, total: ready.length });
    try {
      const archive = await buildZip(ready, (tick) =>
        setJob({ kind: 'zip', done: tick.done, total: tick.total }),
      );
      downloadBlob(archive, archiveName());
      notify('toast.zipDone');
    } catch {
      notify('error.zipFailed');
    } finally {
      jobRef.current = false;
      setJob(null);
    }
  }, [notify, passthroughResult]);

  const exportBatchReport = useCallback(async () => {
    if (jobRef.current) return;
    const targets: ReportInput[] = [];
    for (const item of itemsRef.current) {
      if (!item.scan) continue;
      const result = item.result;
      targets.push({
        file: item.file,
        scan: item.scan,
        options: settingsRef.current.options,
        bake: settingsRef.current.bake,
        redact: settingsRef.current.redactReports,
        result: result
          ? {
              size: result.size,
              filename: result.filename,
              removed: result.removed,
              removedBytes: result.removedBytes,
              reencoded: result.reencoded,
              bakeFailed: result.bakeFailed ?? false,
              verify: result.verify,
            }
          : undefined,
      });
    }
    if (targets.length === 0) {
      notify('error.noFiles');
      return;
    }
    jobRef.current = true;
    setJob({ kind: 'report', done: 0, total: targets.length });
    try {
      const json = await buildBatchReport(targets, (done, total) =>
        setJob({ kind: 'report', done, total }),
      );
      downloadBlob(new Blob([json], { type: 'application/json' }), batchReportName());
      notify('toast.reportBatch');
    } catch {
      notify('error.reportFailed');
    } finally {
      jobRef.current = false;
      setJob(null);
    }
  }, [notify]);

  const setOptions = useCallback((patch: Partial<StripOptions>) => {
    setSettings((prev) => ({ ...prev, options: { ...prev.options, ...patch } }));
  }, []);

  const setBake = useCallback((value: boolean) => {
    setSettings((prev) => ({ ...prev, bake: value }));
  }, []);

  const setRedactReports = useCallback((value: boolean) => {
    setSettings((prev) => ({ ...prev, redactReports: value }));
  }, []);

  // A queued batch counts as busy even before the first file starts, otherwise
  // the toolbar offers a second run while the first one is still waiting.
  const busy =
    batchRunning || items.some((item) => item.state === 'scanning' || item.state === 'stripping');

  return {
    items,
    addFiles,
    removeItem,
    clear,
    stripItem,
    stripAll,
    downloadItem,
    downloadAll,
    exportReport,
    exportBatchReport,
    inspectItem,
    inspectResult,
    options: settings.options,
    setOptions,
    bake: settings.bake,
    setBake,
    redactReports: settings.redactReports,
    setRedactReports,
    busy,
    progress,
    scanProgress,
    job,
    cancelling,
    cancelBatch,
  };
}
