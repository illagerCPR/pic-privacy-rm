/** Run async tasks with a hard concurrency cap; preserves call order of results. */
export function createLimiter(concurrency: number) {
  let active = 0;
  const waiting: (() => void)[] = [];

  const release = () => {
    active -= 1;
    const next = waiting.shift();
    if (next) next();
  };

  return async function limit<T>(task: () => Promise<T>): Promise<T> {
    if (active >= concurrency) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    active += 1;
    try {
      return await task();
    } finally {
      release();
    }
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
