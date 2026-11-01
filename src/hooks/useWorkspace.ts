import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PipelineClient } from '../lib/pipeline-client.ts';
import type { MetadataReport } from '../core/metadata.ts';
import type { RemovalEntry, ScanResult, StripOptions, VerifyResult } from '../core/types.ts';
import { DEFAULT_STRIP_OPTIONS } from '../core/types.ts';
import { bakeOrientation } from '../lib/bake.ts';
import { archiveName, buildZip, downloadBlob } from '../lib/download.ts';
import { buildReport, reportFileName } from '../lib/report.ts';
import { looksLikeImage, outputName, sortFilesByName, uniqueName } from '../lib/files.ts';
import { createLimiter } from '../lib/queue.ts';

export type ItemState =
  | 'scanning'
  | 'ready'
  | 'clean'
  | 'unsupported'
  | 'error'
  | 'stripping'
  | 'done'
  | 'failed';

export interface ItemResult {
  blob: Blob;
  filename: string;
  size: number;
  removed: RemovalEntry[];
  removedBytes: number;
  verify: VerifyResult;
  reencoded: boolean;
}

export interface Item {
  id: string;
  file: File;
  name: string;
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

interface Settings {
  options: StripOptions;
  bake: boolean;
}

const SETTINGS_KEY = 'picprivacy.settings';

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
      };
    }
  } catch {
    /* ignore */
  }
  return { options: DEFAULT_STRIP_OPTIONS, bake: false };
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

export interface Workspace {
  items: Item[];
  addFiles: (files: File[]) => void;
  removeItem: (id: string) => void;
  clear: () => void;
  stripItem: (id: string) => Promise<void>;
  stripAll: () => Promise<void>;
  downloadItem: (id: string) => Promise<void>;
  downloadAll: () => Promise<void>;
  /** Write a reproducible JSON report of what the engine saw and did. */
  exportReport: (id: string) => Promise<void>;
  /** Full metadata listing, parsed lazily and cached per item. */
  inspectItem: (id: string) => Promise<MetadataReport | null>;
  /** The same listing for the stripped output, used by the before/after view. */
  inspectResult: (id: string) => Promise<MetadataReport | null>;
  options: StripOptions;
  setOptions: (patch: Partial<StripOptions>) => void;
  bake: boolean;
  setBake: (value: boolean) => void;
  busy: boolean;
  progress: { done: number; total: number } | null;
}

export function useWorkspace(pipeline: PipelineClient, notify: NotifyFn): Workspace {
  const [items, setItems] = useState<Item[]>([]);
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const itemsRef = useRef<Item[]>([]);
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
        patchItem(item.id, {
          state: 'error',
          error: error instanceof Error ? error.message : 'error.unreadable',
        });
      }
    },
    [patchItem, pipeline, scanLimit],
  );

  const addFiles = useCallback(
    (files: File[]) => {
      const accepted = files.filter(isImageLike);
      const skipped = files.length - accepted.length;
      if (accepted.length === 0) {
        if (skipped > 0) notify('toast.skipped', { n: skipped });
        return;
      }
      const sorted = sortFilesByName(accepted);
      const created: Item[] = sorted.map((file) => ({
        id: makeId(),
        file,
        name: file.name,
        size: file.size,
        previewUrl: URL.createObjectURL(file),
        state: 'scanning',
      }));
      updateItems((prev) => [...prev, ...created]);
      notify('toast.added', { n: created.length });
      if (skipped > 0) notify('toast.skipped', { n: skipped });
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
  }, [updateItems]);

  const runInspect = useCallback(
    async (id: string, side: 'src' | 'out'): Promise<MetadataReport | null> => {
      const key = `${id}:${side}`;
      const cached = inspectCache.current.get(key);
      if (cached) return cached;
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
    async (item: Item) => {
      patchItem(item.id, { state: 'stripping', error: undefined });
      try {
        const outcome = await stripLimit(() => pipeline.strip(item.file, settingsRef.current.options));
        let { blob } = outcome.result;
        let mime = outcome.result.mime;
        let ext = outcome.result.ext;
        let verify = outcome.verify;
        let reencoded = false;

        const orientation = item.scan?.orientation ?? 1;
        if (settingsRef.current.bake && orientation > 1) {
          const baked = await bakeOrientation(blob, orientation, mime);
          if (baked.blob !== blob) {
            blob = baked.blob;
            mime = baked.mime;
            ext = baked.ext;
            reencoded = true;
            verify = await pipeline.verify(blob);
          }
        }

        const result: ItemResult = {
          blob,
          filename: outputName(item.name, ext),
          size: blob.size,
          removed: outcome.result.removed,
          removedBytes: outcome.result.removedBytes,
          verify,
          reencoded,
        };

        inspectCache.current.delete(`${item.id}:out`);
        if (!verify.ok) {
          patchItem(item.id, { state: 'failed', error: 'error.verifyFailed', result });
          return;
        }
        patchItem(item.id, { state: 'done', result });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'error.stripFailed';
        patchItem(item.id, { state: 'failed', error: message });
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
    const targets = itemsRef.current.filter((item) => item.state === 'ready' || item.state === 'failed');
    if (targets.length === 0) return;
    setProgress({ done: 0, total: targets.length });
    let done = 0;
    // stripOne() itself goes through the shared limiter; do not nest another one
    // (two outer holders would each wait for an inner slot and deadlock).
    await Promise.all(
      targets.map(async (item) => {
        await stripOne(item);
        done += 1;
        setProgress({ done, total: targets.length });
      }),
    );
    setProgress(null);
    const finished = itemsRef.current.filter((item) => item.state === 'done').length;
    notify('toast.done', { n: finished });
    // The default path drops the orientation tag; say so instead of leaving the
    // user to discover a sideways photo in their gallery.
    const sideways = itemsRef.current.filter(
      (item) =>
        item.state === 'done' && !settingsRef.current.bake && (item.scan?.orientation ?? 1) > 1,
    ).length;
    if (sideways > 0) notify('toast.orientationLost', { n: sideways });
  }, [notify, stripLimit, stripOne]);

  /** A clean file still gets a downloadable copy, byte-identical to the input. */
  const passthroughResult = useCallback((item: Item): ItemResult => {
    const scan = item.scan;
    return {
      blob: item.file,
      filename: outputName(item.name, scan?.format === 'jpeg' ? 'jpg' : scan?.format ?? 'bin'),
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
        result: item.result
          ? {
              size: item.result.size,
              filename: item.result.filename,
              removed: item.result.removed,
              removedBytes: item.result.removedBytes,
              reencoded: item.result.reencoded,
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
      const result = item.result ?? (item.state === 'clean' ? passthroughResult(item) : undefined);
      if (!result) return;
      downloadBlob(result.blob, result.filename);
    },
    [passthroughResult],
  );

  const downloadAll = useCallback(async () => {
    const ready: { name: string; blob: Blob }[] = [];
    const taken = new Set<string>();
    for (const item of itemsRef.current) {
      const result = item.result ?? (item.state === 'clean' ? passthroughResult(item) : undefined);
      if (!result) continue;
      ready.push({ name: uniqueName(result.filename, taken), blob: result.blob });
    }
    if (ready.length === 0) {
      notify('error.noFiles');
      return;
    }
    notify('toast.zip');
    try {
      const archive = await buildZip(ready);
      downloadBlob(archive, archiveName());
      notify('toast.zipDone');
    } catch {
      notify('error.zipFailed');
    }
  }, [notify, passthroughResult]);

  const setOptions = useCallback((patch: Partial<StripOptions>) => {
    setSettings((prev) => ({ ...prev, options: { ...prev.options, ...patch } }));
  }, []);

  const setBake = useCallback((value: boolean) => {
    setSettings((prev) => ({ ...prev, bake: value }));
  }, []);

  const busy = items.some((item) => item.state === 'scanning' || item.state === 'stripping');

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
    inspectItem,
    inspectResult,
    options: settings.options,
    setOptions,
    bake: settings.bake,
    setBake,
    busy,
    progress,
  };
}
