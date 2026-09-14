import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  instrument,
  traceLLMCall,
  shutdown,
  resetForTests,
  getConfigForTests,
} from '../src/index.js';
import { withEnv } from '../src/env.js';

const CLEAN_ENV = {
  LANGFUSE_HOST: undefined,
  LANGFUSE_PUBLIC_KEY: undefined,
  LANGFUSE_SECRET_KEY: undefined,
  CORTEX_TELEMETRY_SERVICE: undefined,
  CORTEX_TELEMETRY_ENV: undefined,
  CORTEX_TELEMETRY_DISABLED: undefined,
  NODE_ENV: undefined,
};

beforeEach(() => {
  resetForTests();
});

describe('instrument()', () => {
  it('no-ops when LANGFUSE_HOST is unset', () => {
    const res = withEnv(CLEAN_ENV, () => instrument({ service: 'test' }));
    expect(res.enabled).toBe(false);
    expect(res.service).toBe('test');
  });

  it('no-ops when CORTEX_TELEMETRY_DISABLED=1 even with creds set', () => {
    const res = withEnv(
      {
        ...CLEAN_ENV,
        LANGFUSE_HOST: 'http://lf',
        LANGFUSE_PUBLIC_KEY: 'pk',
        LANGFUSE_SECRET_KEY: 'sk',
        CORTEX_TELEMETRY_DISABLED: '1',
      },
      () => instrument(),
    );
    expect(res.enabled).toBe(false);
  });

  it('is idempotent — second call returns same status without re-init', () => {
    const a = withEnv(CLEAN_ENV, () => instrument({ service: 'svc-a' }));
    const b = withEnv(CLEAN_ENV, () => instrument({ service: 'svc-b' }));
    expect(a.enabled).toBe(false);
    expect(b.enabled).toBe(false);
    // service from first call wins
    expect(getConfigForTests().service).toBe('svc-a');
  });

  it('defaults service from CORTEX_TELEMETRY_SERVICE env when no opt given', () => {
    withEnv({ ...CLEAN_ENV, CORTEX_TELEMETRY_SERVICE: 'env-service' }, () => instrument());
    expect(getConfigForTests().service).toBe('env-service');
  });

  it('defaults env to NODE_ENV when not provided', () => {
    withEnv({ ...CLEAN_ENV, NODE_ENV: 'staging' }, () => instrument());
    expect(getConfigForTests().env).toBe('staging');
  });
});

describe('traceLLMCall()', () => {
  it('runs the handler when telemetry is disabled', async () => {
    const fn = vi.fn().mockResolvedValue({ text: 'hello' });
    const result = await withEnv(CLEAN_ENV, () => traceLLMCall({ name: 'test.call' }, fn));
    expect(fn).toHaveBeenCalledOnce();
    expect(result).toEqual({ text: 'hello' });
  });

  it('propagates handler errors when telemetry is disabled', async () => {
    const err = new Error('boom');
    await expect(
      withEnv(CLEAN_ENV, () =>
        traceLLMCall({ name: 'x' }, async () => {
          throw err;
        }),
      ),
    ).rejects.toBe(err);
  });

  it('rejects non-function handlers', async () => {
    await expect(
      withEnv(CLEAN_ENV, () => traceLLMCall({ name: 'x' }, /** @type any */ (null))),
    ).rejects.toThrow(/handler must be a function/);
  });

  it('auto-initialises on first call when instrument() not invoked', async () => {
    resetForTests();
    const fn = vi.fn().mockResolvedValue(42);
    await withEnv(CLEAN_ENV, () => traceLLMCall({ name: 'auto' }, fn));
    expect(getConfigForTests()).not.toBeNull();
  });
});

describe('shutdown()', () => {
  it('is safe to call when telemetry never initialised', async () => {
    await expect(withEnv(CLEAN_ENV, () => shutdown())).resolves.toBeUndefined();
  });

  it('is safe to call after a no-op instrument()', async () => {
    withEnv(CLEAN_ENV, () => instrument());
    await expect(withEnv(CLEAN_ENV, () => shutdown())).resolves.toBeUndefined();
  });
});
