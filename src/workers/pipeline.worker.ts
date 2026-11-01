/** Runs scanning and stripping off the main thread.
 *
 * Jobs are executed strictly one at a time: a single worker thread gains nothing
 * from interleaving two Blob-reading jobs, and serial execution keeps memory
 * flat and behaviour deterministic.
 */
import { scanFile, stripFile, verifyBlob } from '../core/pipeline.ts';
import type { StripOptions } from '../core/types.ts';

type Request =
  | { id: number; kind: 'scan'; file: File }
  | { id: number; kind: 'strip'; file: File; options: StripOptions }
  | { id: number; kind: 'verify'; blob: Blob };

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<Request>) => void) | null;
  postMessage: (message: unknown) => void;
};

async function handle(request: Request): Promise<void> {
  try {
    if (request.kind === 'scan') {
      const scan = await scanFile(request.file);
      scope.postMessage({ id: request.id, ok: true, kind: 'scan', scan });
      return;
    }
    if (request.kind === 'strip') {
      const outcome = await stripFile(request.file, request.options);
      scope.postMessage({ id: request.id, ok: true, kind: 'strip', outcome });
      return;
    }
    const verify = await verifyBlob(request.blob);
    scope.postMessage({ id: request.id, ok: true, kind: 'verify', verify });
  } catch (error) {
    scope.postMessage({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

let queue: Promise<void> = Promise.resolve();

scope.onmessage = (event: MessageEvent<Request>) => {
  const request = event.data;
  queue = queue.then(() => handle(request)).catch(() => undefined);
};
