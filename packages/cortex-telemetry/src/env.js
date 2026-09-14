/**
 * Centralised environment-variable accessors for @cortexos/telemetry.
 *
 * Per MP-020, all process.env reads live in this single file so the rest of
 * the package can lint under `n/no-process-env`. Test fixtures mutate env
 * through `withEnv()` so reads/writes stay scoped to this module.
 */

export function envFlag(name, fallback = false) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return v === '1' || v.toLowerCase() === 'true';
}

export function readConfig({ service, env } = {}) {
  const host = process.env.LANGFUSE_HOST || '';
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY || '';
  const secretKey = process.env.LANGFUSE_SECRET_KEY || '';
  return {
    enabled: Boolean(host && publicKey && secretKey),
    host,
    publicKey,
    secretKey,
    service: service || process.env.CORTEX_TELEMETRY_SERVICE || 'cortexos',
    env: env || process.env.CORTEX_TELEMETRY_ENV || process.env.NODE_ENV || 'production',
    disabledByFlag: envFlag('CORTEX_TELEMETRY_DISABLED', false),
  };
}

/**
 * Run a function with temporary environment overrides, restoring the original
 * values afterwards. Reads/writes are scoped to this module, so tests never
 * need their own `n/no-process-env` override.
 *
 * @template T
 * @param {Record<string, string|undefined>} overrides
 * @param {() => T} fn
 * @returns {T}
 */
export function withEnv(overrides, fn) {
  const keys = Object.keys(overrides);
  const saved = {};
  keys.forEach((k) => {
    saved[k] = process.env[k];
    const v = overrides[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  });
  const restore = () => {
    keys.forEach((k) => {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    });
  };
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.finally(restore);
    }
    restore();
    return result;
  } catch (err) {
    restore();
    throw err;
  }
}
