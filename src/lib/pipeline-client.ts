/** Main-thread facade over a small worker pool, with a same-thread fallback. */
import { PipelineError, WORKER_FAILURE_CODES, type PipelineErrorCode } from '../core/errors.ts';
import { inspectBlob, type InspectOptions } from '../core/inspect.ts';
import type { MetadataReport } from '../core/metadata.ts';
import { scanFile, stripFile, verifyBlob, type StripOutcome } from '../core/pipeline.ts';
import type { ScanResult, StripOptions, VerifyResult } from '../core/types.ts';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: number;
  worker: Worker;
}

/** A worker that has not answered for this long is presumed wedged. */
const REQUEST_TIMEOUT_MS = 45_000;
/**
 * Two workers: scanning is the read-heavy half and benefits from overlap, while
 * stripping stays serial through the limiter in useWorkspace. More workers
 * would mostly add another copy of the current file.
 */
const POOL_SIZE = 2;

export interface PipelineClient {
  readonly mode: 'worker' | 'inline';
  scan(file: File): Promise<ScanResult>;
  strip(file: File, options: StripOptions): Promise<StripOutcome>;
  verify(blob: Blob): Promise<VerifyResult>;
  inspect(blob: Blob, options: InspectOptions): Promise<MetadataReport>;
  dispose(): void;
}

interface WorkerError {
  code: PipelineErrorCode;
  params?: Record<string, string | number>;
}

interface WorkerReply {
  id: number;
  ok: boolean;
  kind?: 'scan' | 'strip' | 'verify' | 'inspect';
  error?: WorkerError;
  scan?: unknown;
  outcome?: unknown;
  verify?: unknown;
  report?: unknown;
}

export function createPipelineClient(): PipelineClient {
  const pending = new Map<number, Pending>();
  let workers: Worker[] = [];
  let nextIndex = 0;
  let nextId = 1;
  let broken = false;

  const failWorker = (worker: Worker, code: PipelineErrorCode): void => {
    for (const [id, entry] of pending) {
      if (entry.worker !== worker) continue;
      window.clearTimeout(entry.timer);
      entry.reject(new PipelineError(code));
      pending.delete(id);
    }
    worker.terminate();
    workers = workers.filter((candidate) => candidate !== worker);
    if (workers.length === 0) broken = true;
  };

  const spawn = (): Worker | null => {
    try {
      const worker = new Worker(new URL('../workers/pipeline.worker.ts', import.meta.url), {
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
          entry.reject(
            data.error
              ? new PipelineError(data.error.code, data.error.params)
              : new PipelineError('strip-failed'),
          );
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
          entry.reject(new PipelineError('worker-empty-response'));
          return;
        }
        entry.resolve(payload);
      });
      worker.addEventListener('error', () => failWorker(worker, 'worker-crashed'));
      worker.addEventListener('messageerror', () => failWorker(worker, 'worker-message-error'));
      return worker;
    } catch {
      return null;
    }
  };

  for (let index = 0; index < POOL_SIZE; index += 1) {
    const worker = spawn();
    if (worker) workers.push(worker);
  }
  if (workers.length === 0) broken = true;

  const request = <T>(message: Record<string, unknown>, fallback: () => Promise<T>): Promise<T> => {
    if (broken || workers.length === 0) return fallback();
    const worker = workers[nextIndex % workers.length]!;
    nextIndex += 1;
    const id = nextId;
    nextId += 1;
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        if (!pending.has(id)) return;
        // The worker went silent mid-job. Drop it, fail whatever else it held,
        // and let the callers retry on the other worker or the main thread.
        failWorker(worker, 'worker-timeout');
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer, worker });
      try {
        worker.postMessage({ ...message, id });
      } catch {
        pending.delete(id);
        window.clearTimeout(timer);
        reject(new PipelineError('worker-crashed'));
      }
    }).catch((error: unknown) => {
      // A domain error (unsupported format, damaged file) is the answer, not a
      // reason to redo the same work on the main thread.
      if (error instanceof PipelineError && !WORKER_FAILURE_CODES.has(error.code)) throw error;
      return fallback();
    });
  };

  return {
    get mode() {
      return broken || workers.length === 0 ? 'inline' : 'worker';
    },
    scan(file) {
      return request<ScanResult>({ kind: 'scan', file }, () => scanFile(file));
    },
    strip(file, options) {
      return request<StripOutcome>({ kind: 'strip', file, options }, () =>
        stripFile(file, options),
      );
    },
    verify(blob) {
      return request<VerifyResult>({ kind: 'verify', blob }, () => verifyBlob(blob));
    },
    inspect(blob, options) {
      return request<MetadataReport>({ kind: 'inspect', blob, keepIcc: options.keepIcc }, () =>
        inspectBlob(blob, options),
      );
    },
    dispose() {
      broken = true;
      for (const [, entry] of pending) {
        window.clearTimeout(entry.timer);
        entry.reject(new PipelineError('worker-disposed'));
      }
      pending.clear();
      for (const worker of workers) worker.terminate();
      workers = [];
    },
  };
}
