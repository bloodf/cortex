const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 300_000;

export function nextBackoffMs(attempt: number, rand: () => number = Math.random): number {
  const raw = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);
  const jitter = raw * ((rand() * 2 - 1) * 0.2);
  return raw + jitter;
}

export function nextAttempt(prev: number, ok: boolean): number {
  return ok ? 0 : prev + 1;
}

export interface ListenerStepDeps {
  waitForNewMail: () => Promise<void>;
  sweep: () => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  onError?: (err: unknown) => void;
  rand?: () => number;
}

export async function listenerStep(attempt: number, deps: ListenerStepDeps): Promise<number> {
  const rand = deps.rand ?? Math.random;
  try {
    await deps.waitForNewMail();
    await deps.sweep();
    return nextAttempt(attempt, true);
  } catch (error) {
    deps.onError?.(error);
    await deps.sleep(nextBackoffMs(attempt, rand));
    return nextAttempt(attempt, false);
  }
}
