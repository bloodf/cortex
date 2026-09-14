import { describe, expect, it, vi } from 'vitest';
import { listenerStep, nextAttempt, nextBackoffMs } from '../src/backoff.js';

describe('nextBackoffMs', () => {
  it('doubles from a 5_000 ms base per attempt', () => {
    expect(nextBackoffMs(0, () => 0.5)).toBe(5_000);
    expect(nextBackoffMs(1, () => 0.5)).toBe(10_000);
    expect(nextBackoffMs(2, () => 0.5)).toBe(20_000);
    expect(nextBackoffMs(3, () => 0.5)).toBe(40_000);
    expect(nextBackoffMs(4, () => 0.5)).toBe(80_000);
    expect(nextBackoffMs(5, () => 0.5)).toBe(160_000);
  });

  it('caps the raw exponential value at 300_000 ms before jitter', () => {
    // attempt 6 would be 320_000 raw, so it should be capped to 300_000
    expect(nextBackoffMs(6, () => 0.5)).toBe(300_000);
    expect(nextBackoffMs(10, () => 0.5)).toBe(300_000);
  });

  it('applies ±20% jitter after the cap', () => {
    expect(nextBackoffMs(0, () => 0)).toBe(5_000 * 0.8);
    expect(nextBackoffMs(0, () => 1)).toBe(5_000 * 1.2);

    expect(nextBackoffMs(6, () => 0)).toBe(300_000 * 0.8);
    expect(nextBackoffMs(6, () => 1)).toBe(300_000 * 1.2);
  });

  it('uses Math.random by default', () => {
    const value = nextBackoffMs(0);
    expect(value).toBeGreaterThanOrEqual(5_000 * 0.8);
    expect(value).toBeLessThanOrEqual(5_000 * 1.2);
  });
});

describe('nextAttempt', () => {
  it('resets to 0 after a success', () => {
    expect(nextAttempt(5, true)).toBe(0);
    expect(nextAttempt(0, true)).toBe(0);
  });

  it('increments after a failure', () => {
    expect(nextAttempt(0, false)).toBe(1);
    expect(nextAttempt(3, false)).toBe(4);
  });
});

describe('listenerStep', () => {
  it('runs waitForNewMail and sweep, then resets attempt on success', async () => {
    const waitForNewMail = vi.fn().mockResolvedValue(undefined);
    const sweep = vi.fn().mockResolvedValue(undefined);
    const sleep = vi.fn().mockResolvedValue(undefined);

    const next = await listenerStep(2, { waitForNewMail, sweep, sleep, rand: () => 0.5 });

    expect(waitForNewMail).toHaveBeenCalledTimes(1);
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(sweep).toHaveBeenCalledAfter(waitForNewMail);
    expect(sleep).not.toHaveBeenCalled();
    expect(next).toBe(0);
  });

  it('calls onError, sleeps the computed backoff, and increments attempt when waitForNewMail throws', async () => {
    const waitForNewMail = vi.fn().mockRejectedValue(new Error('imap gone'));
    const sweep = vi.fn().mockResolvedValue(undefined);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();
    const attempt = 3;

    const next = await listenerStep(attempt, {
      waitForNewMail,
      sweep,
      sleep,
      onError,
      rand: () => 0.5,
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'imap gone' }));
    expect(sweep).not.toHaveBeenCalled();
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(nextBackoffMs(attempt, () => 0.5));
    expect(next).toBe(nextAttempt(attempt, false));
  });

  it('calls onError, sleeps the computed backoff, and increments attempt when sweep throws', async () => {
    const waitForNewMail = vi.fn().mockResolvedValue(undefined);
    const sweep = vi.fn().mockRejectedValue(new Error('sweep failed'));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();
    const attempt = 1;

    const next = await listenerStep(attempt, {
      waitForNewMail,
      sweep,
      sleep,
      onError,
      rand: () => 0.5,
    });

    expect(waitForNewMail).toHaveBeenCalledTimes(1);
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'sweep failed' }));
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(nextBackoffMs(attempt, () => 0.5));
    expect(next).toBe(nextAttempt(attempt, false));
  });

  it('forwards the injected rand to nextBackoffMs', async () => {
    const waitForNewMail = vi.fn().mockRejectedValue(new Error('boom'));
    const sweep = vi.fn().mockResolvedValue(undefined);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const attempt = 0;

    await listenerStep(attempt, { waitForNewMail, sweep, sleep, rand: () => 0.5 });

    expect(sleep).toHaveBeenCalledWith(nextBackoffMs(attempt, () => 0.5));
  });
});
