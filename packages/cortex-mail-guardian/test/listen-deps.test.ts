import { describe, expect, it, vi } from 'vitest';

const { runSweepWithDeps } = await import('../src/index.js');

describe('reusable sweep resource ownership', () => {
  function makeDeps() {
    const sweepFn = vi.fn(async () => ({
      processed: 0,
      trashed: 0,
      review: 0,
      kept: 0,
      skipped: 0,
      failed: 0,
      actions: 0,
      openReviews: 0,
    }));
    const deps = {
      config: {
        // Telegram intentionally disabled so runSweepWithDeps takes the
        // no-assertReady branch and we isolate the dep-reuse behaviour.
        accounts: [{ slug: 'acct' }],
        telegramBotToken: undefined,
        telegramOwnerChatId: undefined,
      },
      store: {},
      mail: {},
      telegram: {},
    } as never;
    return { deps, sweepFn };
  }

  it('runSweepWithDeps never closes the deps it was handed', async () => {
    const { deps, sweepFn } = makeDeps();
    const close = vi.fn();
    (deps as { store: { close?: () => void }; mail: { close?: () => void } }).store.close = close;
    (deps as { mail: { close?: () => void } }).mail.close = close;

    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = () => true;
    try {
      await runSweepWithDeps(deps, sweepFn);
      await runSweepWithDeps(deps, sweepFn);
    } finally {
      process.stdout.write = origWrite;
    }

    // Caller owns the deps lifecycle; the reusable sweep must not tear them down.
    expect(close).not.toHaveBeenCalled();
    expect(sweepFn).toHaveBeenCalledTimes(2);
  });
});
