/** Main-thread facade over the worker, with a graceful same-thread fallback. */
import { inspectFile, type InspectOptions } from '../core/inspect.ts';
import type { MetadataReport } from '../core/metadata.ts';
import { scanFile, stripFile, verifyBlob, type StripOutcome } from '../core/pipeline.ts';
import type { ScanResult, StripOptions, VerifyResult } from '../core/types.ts';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: number;
}

/** A worker that has not answered for this long is presumed wedged. */
const REQUEST_TIMEOUT_MS = 45_000;

export interface PipelineClient {
  readonly mode: 'worker' | 'inline';
  scan(file: File): Promise<ScanResult>;
  strip(file: File, options: StripOptions): Promise<StripOutcome>;
  verify(blob: Blob): Promise<VerifyResult>;
  inspect(file: File, options: InspectOptions): Promise<MetadataReport>;
  dispose(): void;
}

interface WorkerReply {
  id: number;
  ok: boolean;
  kind?: 'scan' | 'strip' | 'verify' | 'inspect';
  error?: string;
  scan?: unknown;
  outcome?: unknown;
  verify?: unknown;
  report?: unknown;
}

export function createPipelineClient(): PipelineClient {
  let worker: Worker | null = null;
  let broken = false;
  const pending = new Map<number, Pending>();
  let nextId = 1;

  const failAll = (reason: string) => {
    for (const [, entry] of pending) {
      window.clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    pending.clear();
  };

  const disable = (reason: string) => {
    if (broken) return;
    broken = true;
    failAll(reason);
    worker?.terminate();
    worker = null;
  };

  try {
    worker = new Worker(new URL('../workers/pipeline.worker.ts', import.meta.url), {
      type: 'module',
      name: 'picprivacy-pipeline',
    });
    worker.addEventListener('message', (event: MessageEvent<WorkerReply>) => {
      const data = event.data;
      const entry = pending.get(data.id);
      if (!entry) return;
      pending.delete(data.id);
      window.clearTimeout(entry.timer);
      if (!data.ok) {
        entry.reject(new Error(data.error ?? 'worker-error'));
        return;
      }
      const payload =
        data.kind === 'scan'
          ? data.scan
          : data.kind === 'strip'
            ? data.outcome
            : data.kind === 'inspect'
              ? data.report
              : data.verify;
      if (payload === undefined) {
        entry.reject(new Error('worker-empty-response'));
        return;
      }
      entry.resolve(payload);
    });
    worker.addEventListener('error', () => disable('worker-crashed'));
    worker.addEventListener('messageerror', () => disable('worker-message-error'));
  } catch {
    broken = true;
    worker = null;
  }

  const request = <T>(message: Record<string, unknown>, fallback: () => Promise<T>): Promise<T> => {
    if (broken || !worker) return fallback();
    const id = nextId;
    nextId += 1;
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        if (!pending.has(id)) return;
        // The worker went silent mid-job. Reject everything queued behind it and
        // continue on the main thread so a batch can never hang forever.
        disable('worker-timeout');
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      worker?.postMessage({ ...message, id });
    }).catch(() => fallback());
  };

  return {
    get mode() {
      return broken || !worker ? 'inline' : 'worker';
    },
    scan(file) {
      return request<ScanResult>({ kind: 'scan', file }, () => scanFile(file));
    },
    strip(file, options) {
      return request<StripOutcome>({ kind: 'strip', file, options }, () => stripFile(file, options));
    },
    verify(blob) {
      return request<VerifyResult>({ kind: 'verify', blob }, () => verifyBlob(blob));
    },
    inspect(file, options) {
      return request<MetadataReport>({ kind: 'inspect', file, keepIcc: options.keepIcc }, () =>
        inspectFile(file, options),
      );
    },
    dispose() {
      disable('disposed');
    },
  };
}
