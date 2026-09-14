/**
 * Server-side config — session cookie names, HMAC keys, defaults.
 *
 * In M3 this is replaced with values sourced from `.secrets/cortexos.env` and
 * the database. For M1 the values are in-memory and can be overridden by env
 * vars in tests.
 */

import { createHash, randomBytes } from "node:crypto";

/** Session cookie name (THREAT_MODEL SR-001). */
export const SESSION_COOKIE = "cortexos_session";

/** CSRF cookie name (double-submit pattern, THREAT_MODEL SR-004). */
export const CSRF_COOKIE = "cortexos_csrf";

/** Default approval-token TTL in seconds (THREAT_MODEL §3.5). */
export const APPROVAL_DEFAULT_TTL_SEC = 60;

/** Reveal-token TTL is longer because the user is reading (THREAT_MODEL §3.5). */
export const APPROVAL_REVEAL_TTL_SEC = 300;

/** Default rate-limit window (seconds) — applies to per-IP and per-user buckets. */
export const RATE_LIMIT_DEFAULT_WINDOW_SEC = 60;

/** Stricter default for token-mint endpoints (THREAT_MODEL SR-200). */
export const RATE_LIMIT_TOKEN_MINT_PER_60S = 30;

/**
 * Default for ordinary authenticated reads (auth: "any" gates with no
 * explicit rateLimit). The dashboard's own chrome (command palette,
 * status hero, incident polling) issues several list GETs per page boot;
 * 10/min broke normal multi-page navigation (screen runs 21-22, mass
 * 429s). Expensive/privileged ops keep their explicit per-gate limits.
 */
export const RATE_LIMIT_AUTHED_DEFAULT_PER_60S = 60;

/**
 * HMAC key used to sign approval tokens.
 *
 * In production the key is derived from `CORTEX_MASTER_KEY` (the service's
 * `EnvironmentFile` secret) at server boot via `loadServerHmacKeyFromEnv()`,
 * so approval tokens stay verifiable across process restarts and across
 * worker processes that share the same secret. If the env var is missing in
 * production, boot FAILS CLOSED (see `loadServerHmacKeyFromEnv`).
 *
 * NOTE: the audit CHAIN does NOT use this key — chain hashes are plain
 * sha256 over the prev/row payload (see `src/server/audit`). The only
 * cross-restart impact of this key is approval-token usability.
 *
 * In dev/test, when no secret is set, a random per-process key is generated
 * as a fallback so tests and local dev still run. Tests can also override
 * deterministically via `setServerHmacKey()` / `setServerHmacKeyFromString()`.
 */
let serverHmacKey: Buffer = randomBytes(32);

/** Minimum acceptable raw-secret length before sha256 derivation. */
const MIN_MASTER_KEY_LEN = 16;

export function getServerHmacKey(): Buffer {
  return serverHmacKey;
}

export function setServerHmacKey(key: Buffer): void {
  if (key.length < 16) {
    throw new Error("HMAC key must be at least 16 bytes");
  }
  serverHmacKey = key;
}

/**
 * Convenience for tests: derive a deterministic 32-byte key from a string.
 *
 * Derivation is `sha256(secret)` so any secret length yields a stable
 * 32-byte key. This is the SAME derivation used by
 * `loadServerHmacKeyFromEnv()`, so a test that sets `CORTEX_MASTER_KEY`
 * and a boot that reads it produce identical keys for the same secret.
 */
export function setServerHmacKeyFromString(s: string): void {
  setServerHmacKey(createHash("sha256").update(s, "utf8").digest());
}

/**
 * Load the approval-token HMAC key from `process.env.CORTEX_MASTER_KEY`.
 *
 * Derivation: `sha256(CORTEX_MASTER_KEY)` → 32 bytes (deterministic, any
 * secret length). Two boots with the same secret yield the same key, so
 * approval tokens minted before a restart still verify after it.
 *
 * Fail-closed contract:
 *   - In production (`NODE_ENV === 'production'`): if the secret is absent
 *     or shorter than {@link MIN_MASTER_KEY_LEN} chars, THROW at boot rather
 *     than silently falling back to a random key (which would invalidate
 *     every previously-minted token on each restart/worker).
 *   - In dev/test: if the secret is absent/too short, keep the existing
 *     random per-process key (no throw) so local dev and tests still run.
 *
 * Idempotent and safe to call from the server boot hook.
 */
export function loadServerHmacKeyFromEnv(): void {
  const secret = process.env.CORTEX_MASTER_KEY;
  const isProd = process.env.NODE_ENV === "production";
  if (!secret || secret.length < MIN_MASTER_KEY_LEN) {
    if (isProd) {
      throw new Error(
        `CORTEX_MASTER_KEY is missing or too short (need >= ${MIN_MASTER_KEY_LEN} chars) — refusing to boot with a random approval-signing key in production`,
      );
    }
    // Dev/test: leave the random fallback in place.
    return;
  }
  setServerHmacKey(createHash("sha256").update(secret, "utf8").digest());
}
