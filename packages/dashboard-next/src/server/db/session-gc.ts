/**
 * session-gc.ts — garbage-collect expired admin_sessions rows.
 *
 * A1 (persistent sessions) made the DrizzleSessionStore the default.
 * Sessions are written with `expires_at = now + 30d` and rolled forward
 * on every request via `touch()`. Old rows accumulate: a user who logs
 * in once and never returns leaves a row for 30 days; a user who
 * logs in 1000 times leaves 1000 rows (only one is the active session
 * at any time, the rest are stale).
 *
 * `gcExpiredSessions()` deletes rows where `expires_at < NOW()` and
 * returns the number of rows removed. It is safe to call concurrently
 * — the underlying DELETE is atomic per-row in PostgreSQL.
 *
 * The DrizzleSessionStore exposes this so:
 *   1. The hooks.server.ts can call it once per N requests (cheap
 *      probabilistic GC, no separate timer needed).
 *   2. The dashboard's installer / startup script can call it once
 *      at boot to clean up before the systemd service starts
 *      serving traffic.
 *   3. Tests can call it directly to verify the GC behaviour.
 */
import { lt, sql } from "drizzle-orm";
import { adminSessions } from "./schema";
import type { DbClient } from "./client";

export interface GcResult {
  /** Rows deleted by this call. */
  readonly deleted: number;
  /** Epoch ms when the GC ran. */
  readonly ranAt: number;
}

export async function gcExpiredSessions(db: DbClient): Promise<GcResult> {
  const ranAt = Date.now();
  const result = await db
    .delete(adminSessions)
    .where(lt(adminSessions.expiresAt, sql`NOW()`))
    .returning({ id: adminSessions.id });
  return { deleted: result.length, ranAt };
}
