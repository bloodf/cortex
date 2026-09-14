/**
 * Server-boot runtime hooks — the single place run-once side effects are
 * registered when the Node server starts (NOT per-request).
 *
 * Invoked exactly once from `src/start.ts` (the `createStart` factory runs at
 * server init). Idempotent via the `booted` guard so it is safe even if called
 * more than once.
 *
 * WP-10 wires the periodic health scheduler here.
 */

import { loadServerHmacKeyFromEnv } from "./config";
import { startHealthScheduler } from "./health/scheduler";

let booted = false;

/** Run-once server boot hook. Safe to call multiple times. */
export function bootRuntime(): void {
  if (booted) return;
  booted = true;
  // Derive the approval-token HMAC key from CORTEX_MASTER_KEY so tokens stay
  // verifiable across restarts/workers. Fails closed in production when the
  // secret is missing/too short; falls back to a random key in dev/test.
  loadServerHmacKeyFromEnv();
  // Sweep active services every 60s (immediate first sweep on boot). The
  // scheduler is itself an idempotent singleton; the `booted` guard is the
  // outer safety net.
  startHealthScheduler();
}
