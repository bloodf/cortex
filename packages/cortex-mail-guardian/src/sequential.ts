/**
 * Run an async function over each item in order, returning the collected
 * results. Implemented with `reduce` so callers avoid `no-await-in-loop` and
 * `no-restricted-syntax` while preserving exact sequential semantics.
 */
export const STOP = Symbol('runSequentially.stop');

export default async function runSequentially<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R | typeof STOP>,
): Promise<R[]> {
  const final = await items.reduce<Promise<{ results: R[]; stopped: boolean }>>(
    async (acc, item, i) => {
      const { results, stopped } = await acc;
      if (stopped) return { results, stopped: true };
      const result = await fn(item, i);
      if (result === STOP) return { results, stopped: true };
      return { results: [...results, result], stopped: false };
    },
    Promise.resolve({ results: [], stopped: false }),
  );
  return final.results;
}
