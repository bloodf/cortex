// @cortexos/telemetry — thin wrapper over @traceloop/node-server-sdk and
// langfuse. One-call `instrument({ service, env })` initialises OpenLLMetry
// + a singleton Langfuse client. `traceLLMCall` wraps an LLM invocation so
// inputs / outputs / latency / token-usage land on a Langfuse trace.
//
// Hard requirement: when LANGFUSE_HOST is unset the entire module becomes a
// no-op. Services that import this package must remain safe to boot in
// dev/test environments where no observability stack is running.

import { createRequire } from 'node:module';

import { readConfig } from './env.js';

// CJS shim so we can lazily load optional, peer-style dependencies from an
// ESM module without forcing them to be installed.
const nodeRequire = createRequire(import.meta.url);

let initialized = false;
let traceloop = null;
let langfuse = null;
let config = null;

function langfuseOtelHeaders(publicKey, secretKey) {
  return {
    Authorization: `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString('base64')}`,
    'x-langfuse-ingestion-version': '4',
  };
}

function requireOptional(name) {
  try {
    return nodeRequire(name);
  } catch {
    return null;
  }
}

/**
 * Initialise OpenLLMetry + Langfuse. Idempotent. Safe to call from every
 * service boot path — second and subsequent calls are no-ops. When
 * `LANGFUSE_HOST` is unset or `CORTEX_TELEMETRY_DISABLED=1`, the function
 * returns without loading any SDK.
 *
 * @param {{ service?: string, env?: string }} [opts]
 * @returns {{ enabled: boolean, service: string, env: string }}
 */
export function instrument(opts = {}) {
  if (initialized) {
    return { enabled: Boolean(config?.enabled), service: config?.service, env: config?.env };
  }
  const cfg = readConfig(opts);
  config = cfg;
  initialized = true;
  if (cfg.disabledByFlag || !cfg.enabled) {
    return { enabled: false, service: cfg.service, env: cfg.env };
  }
  try {
    // Lazy-load so the dependency cost is paid only when telemetry is on.

    const traceloopMod = requireOptional('@traceloop/node-server-sdk');
    const langfuseMod = requireOptional('langfuse');
    if (!traceloopMod || !langfuseMod) {
      config = { ...cfg, enabled: false };
      return { enabled: false, service: cfg.service, env: cfg.env };
    }
    traceloopMod.initialize({
      appName: cfg.service,
      apiKey: cfg.secretKey,
      baseUrl: `${cfg.host.replace(/\/$/, '')}/api/public/otel`,
      headers: langfuseOtelHeaders(cfg.publicKey, cfg.secretKey),
      disableBatch: cfg.env !== 'production',
    });
    const LangfuseCtor =
      langfuseMod.Langfuse || langfuseMod.default?.Langfuse || langfuseMod.default;
    langfuse = new LangfuseCtor({
      publicKey: cfg.publicKey,
      secretKey: cfg.secretKey,
      baseUrl: cfg.host,
      flushAt: 1,
    });
    traceloop = traceloopMod;
    return { enabled: true, service: cfg.service, env: cfg.env };
  } catch (err) {
    process.stderr.write(`[telemetry] init failed: ${err.message}\n`);
    config = { ...cfg, enabled: false };
    return { enabled: false, service: cfg.service, env: cfg.env };
  }
}

function extractOutput(result) {
  if (!result || typeof result !== 'object') return result;
  if ('output' in result) return result.output;
  if ('text' in result) return result.text;
  if ('content' in result) return result.content;
  return result;
}

function extractUsage(result) {
  if (!result || typeof result !== 'object') return undefined;
  const u = result.usage || result.token_usage || result.tokenUsage;
  if (!u || typeof u !== 'object') return undefined;
  return {
    input: u.input ?? u.prompt_tokens ?? u.inputTokens,
    output: u.output ?? u.completion_tokens ?? u.outputTokens,
    total: u.total ?? u.total_tokens ?? u.totalTokens,
    unit: u.unit || 'TOKENS',
  };
}

/**
 * Wrap an LLM invocation with a Langfuse generation span. The handler runs
 * regardless of telemetry state. When telemetry is disabled the call passes
 * through with zero overhead beyond a single boolean check.
 *
 * @template T
 * @param {{
 *   name: string,
 *   model?: string,
 *   input?: unknown,
 *   metadata?: Record<string, unknown>,
 *   userId?: string,
 *   sessionId?: string,
 *   tags?: string[],
 * }} spec
 * @param {() => Promise<T>} handler
 * @returns {Promise<T>}
 */
export async function traceLLMCall(spec, handler) {
  if (typeof handler !== 'function') {
    throw new TypeError('traceLLMCall: handler must be a function');
  }
  if (!initialized) instrument();
  if (!config?.enabled || !langfuse) {
    return handler();
  }
  const startedAt = new Date();
  const trace = langfuse.trace({
    name: spec.name,
    userId: spec.userId,
    sessionId: spec.sessionId,
    tags: spec.tags,
    metadata: { ...(spec.metadata || {}), service: config.service, env: config.env },
  });
  const generation = trace.generation({
    name: spec.name,
    model: spec.model,
    input: spec.input,
    startTime: startedAt,
  });
  try {
    const result = await handler();
    const output = extractOutput(result);
    const usage = extractUsage(result);
    generation.end({
      endTime: new Date(),
      output,
      usage,
    });
    return result;
  } catch (err) {
    generation.end({
      endTime: new Date(),
      level: 'ERROR',
      statusMessage: err?.message || String(err),
    });
    throw err;
  }
}

/**
 * Force-flush buffered telemetry. Call from graceful-shutdown handlers so
 * in-flight spans land before the process exits.
 * @returns {Promise<void>}
 */
export async function shutdown() {
  if (!initialized || !config?.enabled) return;
  try {
    if (langfuse?.shutdownAsync) await langfuse.shutdownAsync();
  } catch {
    /* best effort */
  }
  try {
    if (traceloop?.forceFlush) await traceloop.forceFlush();
  } catch {
    /* best effort */
  }
}

/**
 * Internal: test reset hook.
 * @returns {void}
 */
export function resetForTests() {
  initialized = false;
  traceloop = null;
  langfuse = null;
  config = null;
}

/**
 * Internal: peek at the resolved configuration.
 * @returns {Record<string, unknown>|null}
 */
export function getConfigForTests() {
  return config;
}
