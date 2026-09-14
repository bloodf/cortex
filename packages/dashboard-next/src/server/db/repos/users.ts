/**
 * Users repository (PAM users + admin sessions).
 *
 * Encapsulates the RBAC-relevant queries for the dashboard's auth layer.
 * The SvelteKit `hooks.server.ts` will call into this repo to resolve a
 * session cookie to a user + admin status, and to enforce per-user
 * row-level filters.
 *
 * The repo does NOT make auth decisions (that's `requireAuth` /
 * `requireAdmin` in the SvelteKit server layer). It DOES enforce
 * the data-layer invariants:
 *   - session lookups always include `expires_at > NOW()` (a stale
 *     token must never resolve to a session row)
 *   - users see only their own chat_sessions / dashboard_layouts (the
 *     SvelteKit layer calls `getPamUserById(id, { actor })` to verify
 *     the actor matches before reading)
 *   - listing of users is admin-gated at the call site
 */

import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { DbClient } from "../client";
import { adminSessions, pamUsers } from "../schema";
import type { AdminSession, NewAdminSession, PamUser } from "../schema";

export interface PamUserWithSessions extends PamUser {
  activeSessions: number;
  lastLoginAt: Date | null;
  lastExpiresAt: Date | null;
}

export interface ActiveSession extends Omit<AdminSession, "token"> {
  username: string;
}

// =====================================================================
// PAM users
// =====================================================================

/**
 * Upsert a PAM user by username. Returns the row. Throws on empty input.
 *
 * The username is the only natural key; we don't generate slugs.
 */
export async function upsertPamUser(db: DbClient, input: { username: string }): Promise<PamUser> {
  const username = input.username.trim();
  if (!username) {
    throw new Error("PAM username is required");
  }
  const inserted = await db
    .insert(pamUsers)
    .values({ username })
    .onConflictDoUpdate({
      target: pamUsers.username,
      set: { username: sql`EXCLUDED.username` },
    })
    .returning();
  const row = inserted[0];
  if (!row) throw new Error("Failed to upsert PAM user");
  return row;
}

export async function getPamUserById(db: DbClient, id: number): Promise<PamUser | null> {
  const rows = await db.select().from(pamUsers).where(eq(pamUsers.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function getPamUserByUsername(
  db: DbClient,
  username: string,
): Promise<PamUser | null> {
  const rows = await db.select().from(pamUsers).where(eq(pamUsers.username, username)).limit(1);
  return rows[0] ?? null;
}

export async function listPamUsers(db: DbClient): Promise<PamUserWithSessions[]> {
  // Subquery for active session count. Postgres `FILTER` keeps the
  // aggregation in a single pass. The ORDER BY references the
  // raw expression (not a SELECT-list alias) to be portable across
  // PG versions and PGlite.
  return db
    .select({
      id: pamUsers.id,
      username: pamUsers.username,
      createdAt: pamUsers.createdAt,
      activeSessions: sql<number>`COUNT(${adminSessions.id}) FILTER (WHERE ${adminSessions.expiresAt} > NOW())::int`,
      lastLoginAt: sql<Date | null>`MAX(${adminSessions.createdAt})`,
      lastExpiresAt: sql<Date | null>`MAX(${adminSessions.expiresAt}) FILTER (WHERE ${adminSessions.expiresAt} > NOW())`,
    })
    .from(pamUsers)
    .leftJoin(adminSessions, eq(adminSessions.userId, pamUsers.id))
    .groupBy(pamUsers.id, pamUsers.username, pamUsers.createdAt)
    .orderBy(sql`MAX(${adminSessions.createdAt}) DESC NULLS LAST`, asc(pamUsers.username));
}

export async function deletePamUser(db: DbClient, id: number): Promise<boolean> {
  const res = await db.delete(pamUsers).where(eq(pamUsers.id, id)).returning({ id: pamUsers.id });
  return res.length > 0;
}

// =====================================================================
// Admin sessions
// =====================================================================

/**
 * Create a new admin session for a user. The token must be unique —
 * the caller generates it (32-byte hex is the convention in the
 * existing `lib/auth.ts`).
 */
export async function createAdminSession(
  db: DbClient,
  input: NewAdminSession,
): Promise<AdminSession> {
  if (!input.token) throw new Error("Session token is required");
  if (!input.userId) throw new Error("Session userId is required");
  const inserted = await db.insert(adminSessions).values(input).returning();
  const row = inserted[0];
  if (!row) throw new Error("Failed to create admin session");
  return row;
}

/**
 * Resolve a session token to a session + username. Returns null if the
 * token is unknown OR the session is expired. The expiry check is
 * non-negotiable — a stale token must never resolve.
 */
export async function resolveSessionByToken(
  db: DbClient,
  token: string,
): Promise<(AdminSession & { username: string }) | null> {
  const rows = await db
    .select({
      id: adminSessions.id,
      userId: adminSessions.userId,
      token: adminSessions.token,
      csrfToken: adminSessions.csrfToken,
      ip: adminSessions.ip,
      userAgent: adminSessions.userAgent,
      lastRoleCheckAt: adminSessions.lastRoleCheckAt,
      touchedAt: adminSessions.touchedAt,
      expiresAt: adminSessions.expiresAt,
      isAdmin: adminSessions.isAdmin,
      createdAt: adminSessions.createdAt,
      username: pamUsers.username,
    })
    .from(adminSessions)
    .innerJoin(pamUsers, eq(pamUsers.id, adminSessions.userId))
    .where(and(eq(adminSessions.token, token), gt(adminSessions.expiresAt, sql`NOW()`)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Delete a session by token. Idempotent — returns true if a row was
 * removed, false if it was already gone.
 */
export async function deleteAdminSession(db: DbClient, token: string): Promise<boolean> {
  const res = await db
    .delete(adminSessions)
    .where(eq(adminSessions.token, token))
    .returning({ id: adminSessions.id });
  return res.length > 0;
}

export async function deleteAdminSessionsForUser(db: DbClient, userId: number): Promise<number> {
  const res = await db
    .delete(adminSessions)
    .where(eq(adminSessions.userId, userId))
    .returning({ id: adminSessions.id });
  return res.length;
}

export async function listActiveAdminSessions(db: DbClient): Promise<ActiveSession[]> {
  return db
    .select({
      id: adminSessions.id,
      userId: adminSessions.userId,
      csrfToken: adminSessions.csrfToken,
      ip: adminSessions.ip,
      userAgent: adminSessions.userAgent,
      lastRoleCheckAt: adminSessions.lastRoleCheckAt,
      touchedAt: adminSessions.touchedAt,
      expiresAt: adminSessions.expiresAt,
      createdAt: adminSessions.createdAt,
      isAdmin: adminSessions.isAdmin,
      username: pamUsers.username,
    })
    .from(adminSessions)
    .innerJoin(pamUsers, eq(pamUsers.id, adminSessions.userId))
    .where(gt(adminSessions.expiresAt, sql`NOW()`))
    .orderBy(sql`${adminSessions.createdAt} DESC, ${adminSessions.id} DESC`);
}
