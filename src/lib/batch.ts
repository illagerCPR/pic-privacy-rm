/**
 * Batch queue with cooperative cancellation.
 *
 * The strip pass runs inside a shared concurrency limiter, so the only place a
 * cancellation check means anything is *inside* the limited task — checking
 * before enqueueing would look at the token before a single file has started.
 *
 * The file already being worked on is deliberately allowed to finish: its
 * output still has to pass verification, and an aborted strip would leave a row
 * claiming something we never proved.
 */
export interface BatchToken {
  cancelled: boolean;
}

export function createToken(): BatchToken {
  return { cancelled: false };
}

export interface BatchOutcome {
  done: number;
  skipped: number;
}

/**
 * Run `run` for every item, and report progress as items settle.
 *
 * `run` returns false when the item was skipped because the batch was
 * cancelled; anything else counts as processed (a file that failed to strip was
 * still processed — the row says why).
 */
export async function runBatch<T>(
  items: readonly T[],
  run: (item: T, token: BatchToken) => Promise<boolean>,
  token: BatchToken,
  onProgress?: (progress: { done: number; total: number }) => void,
): Promise<BatchOutcome> {
  let done = 0;
  let skipped = 0;
  await Promise.all(
    items.map(async (item) => {
      const processed = await run(item, token);
      if (processed) done += 1;
      else skipped += 1;
      onProgress?.({ done: done + skipped, total: items.length });
    }),
  );
  return { done, skipped };
}
