import { describe, expect, it } from 'vitest';

import { createToken, runBatch, type BatchToken } from '../src/lib/batch.ts';

/** A one-slot limiter, the same shape the workspace uses around the strip pass. */
function makeLimiter(slots = 1) {
  let active = 0;
  const queue: (() => void)[] = [];
  const pump = (): void => {
    while (active < slots && queue.length > 0) {
      const next = queue.shift();
      if (next) next();
    }
  };
  return <T>(task: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        active += 1;
        task()
          .then(resolve, reject)
          .finally(() => {
            active -= 1;
            pump();
          });
      });
      pump();
    });
}

describe('batch queue', () => {
  it('runs every item and reports progress as they settle', async () => {
    const seen: number[] = [];
    const progress: number[] = [];
    const outcome = await runBatch(
      [1, 2, 3, 4],
      async (item) => {
        seen.push(item);
        return true;
      },
      createToken(),
      (next) => progress.push(next.done),
    );

    expect(seen.sort()).toEqual([1, 2, 3, 4]);
    expect(outcome).toEqual({ done: 4, skipped: 0 });
    expect(progress).toEqual([1, 2, 3, 4]);
    expect(progress.at(-1)).toBe(4);
  });

  it('counts a failed item as processed, not as skipped', async () => {
    const outcome = await runBatch([1, 2], async (item) => item !== 2, createToken());
    // run() returning false means "skipped"; the workspace returns true for a
    // strip that failed, because the row does say why.
    expect(outcome).toEqual({ done: 1, skipped: 1 });
  });

  it('leaves queued items untouched when cancelled mid-batch', async () => {
    const limit = makeLimiter(1);
    const token: BatchToken = createToken();
    const started: number[] = [];

    const outcome = await runBatch(
      [1, 2, 3, 4, 5],
      async (item) => {
        // The token is only consulted once a slot is free — checking it before
        // enqueueing would look at it before a single file had started.
        const ran = await limit(async () => {
          if (token.cancelled) return null;
          started.push(item);
          await new Promise((resolve) => setTimeout(resolve, 1));
          return item;
        });
        if (ran === null) return false;
        if (item === 1) token.cancelled = true;
        return true;
      },
      token,
    );

    expect(started).toEqual([1]);
    expect(outcome).toEqual({ done: 1, skipped: 4 });
  });

  it('does not skip anything when the cancel arrives after the last file', async () => {
    const limit = makeLimiter(1);
    const token = createToken();
    const started: number[] = [];

    const outcome = await runBatch(
      [1, 2],
      async (item) => {
        const ran = await limit(async () => {
          if (token.cancelled) return null;
          started.push(item);
          return item;
        });
        if (ran === null) return false;
        token.cancelled = token.cancelled || item === 2;
        return true;
      },
      token,
    );

    expect(started).toEqual([1, 2]);
    expect(outcome).toEqual({ done: 2, skipped: 0 });
  });
});
