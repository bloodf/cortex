/**
 * Run `fn` over `items` sequentially (order-preserving), collecting
 * results.  Implemented as a reduce-chain so the body is lint-clean
 * (no `await` inside a loop construct).
 */
export async function runSequentially<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  await items.reduce<Promise<void>>(
    (chain, item, index) =>
      chain.then(() =>
        fn(item, index).then((r) => {
          results.push(r);
        }),
      ),
    Promise.resolve(),
  );
  return results;
}

/**
 * Run `fn` over `items` sequentially until `done` returns `true` for a
 * result, then return that result.  Implemented as a reduce-chain so the
 * body is lint-clean (no `await` inside a loop construct).
 */
export async function runSequentiallyUntil<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R>,
  done: (result: R) => boolean,
): Promise<R | undefined> {
  let found: R | undefined;
  await items.reduce<Promise<void>>(
    (chain, item, index) =>
      chain.then(async () => {
        if (found !== undefined) return;
        const r = await fn(item, index);
        if (done(r)) found = r;
      }),
    Promise.resolve(),
  );
  return found;
}
