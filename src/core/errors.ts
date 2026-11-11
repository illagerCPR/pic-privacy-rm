/**
 * Typed engine errors.
 *
 * The strip pass used to throw `unreadable:<warning-id>` strings, and the UI
 * rendered whatever it caught — so a damaged JPEG showed an internal id to the
 * user. A code plus optional params lets the UI pick a translated message and
 * lets the worker protocol keep the two sides in sync.
 */
export type PipelineErrorCode =
  | 'unsupported-format'
  | 'unreadable'
  | 'strip-failed'
  | 'worker-crashed'
  | 'worker-timeout'
  | 'worker-message-error'
  | 'worker-empty-response'
  | 'worker-disposed';

export class PipelineError extends Error {
  readonly code: PipelineErrorCode;
  readonly params?: Record<string, string | number>;

  constructor(
    code: PipelineErrorCode,
    params?: Record<string, string | number>,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'PipelineError';
    this.code = code;
    this.params = params;
  }
}

export function isPipelineError(error: unknown): error is PipelineError {
  return error instanceof PipelineError;
}

/** Errors that mean "the worker is gone", where retrying on the main thread helps. */
export const WORKER_FAILURE_CODES: ReadonlySet<PipelineErrorCode> = new Set([
  'worker-crashed',
  'worker-timeout',
  'worker-message-error',
  'worker-empty-response',
]);
