/**
 * cortex-session-auth — shared admin-session auth for WS sidecars (P3.1).
 *
 * Faithful port of the auth contract used by `packages/cortex-terminal`:
 *
 *   1. Session lookup — `admin_sessions` JOIN `pam_users` filtered by token AND
 *      `expires_at > now()`. No/unexpired row → deny (caller closes WS 4401).
 *   2. RBAC — admin is RE-DERIVED LIVE from OS group `cortexos-admin` via
 *      `id -Gn` AND the account must still be active (`id -u`). The denormalized
 *      `admin_sessions.is_admin` column is IGNORED (a revoked admin would
 *      otherwise keep a root shell via a stale row).
 *   3. Freshness — `last_role_check_at` must be within ROLE_CHECK_MAX_AGE_MS
 *      (default 120s, slightly above the dashboard's 60s to tolerate clock
 *      skew). Defence-in-depth so a stale row is never the sole basis.
 *
 * Returns `{ username, isAdmin }` on grant, or `null` to deny. Callers translate
 * `null` to the appropriate close code (4401 unauth, 4403 forbidden).
 *
 * The functions are dependency-injectable (`userActive`, `isAdmin`, `now`,
 * `maxRoleAgeMs`) so the unit test does not need real OS probes or a real DB.
 * `validateSession` wires the real `pg` Pool + `execFileSync` path.
 */

import { execFileSync } from "node:child_process";
import type { Pool } from "pg";

export const SESSION_COOKIE_NAME = "cortexos_session";
export const CSRF_COOKIE_NAME = "cortexos_csrf";
export const ADMIN_GROUP = "cortexos-admin";
export const DEFAULT_ROLE_CHECK_MAX_AGE_MS = 120_000;

let lazyPool: Pool | null = null;
export function configureDbPool(pool: Pool): void {
  lazyPool = pool;
}
function requirePool(): Pool {
  if (!lazyPool) throw new Error("cortex-session-auth: configureDbPool() not called");
  return lazyPool;
}

export interface SessionRow {
  username: string;
  last_role_check_at: number | Date | null;
}

export interface DeriveDeps {
  userActive: (u: string) => boolean;
  isAdmin: (u: string) => boolean;
  now?: () => number;
  maxRoleAgeMs?: number;
}

export function deriveSessionGrant(
  row: SessionRow | null,
  deps: DeriveDeps,
): { username: string; isAdmin: boolean } | null {
  if (!row) return null;
  const username = String(row.username || "");
  if (!username) return null;
  if (!deps.userActive(username)) return null;
  const now = (deps.now ?? Date.now)();
  const maxAge = deps.maxRoleAgeMs ?? DEFAULT_ROLE_CHECK_MAX_AGE_MS;
  const last = row.last_role_check_at instanceof Date
    ? row.last_role_check_at.getTime()
    : Number(row.last_role_check_at) || 0;
  if (now - last > maxAge) return null;
  const isAdmin = deps.isAdmin(username) === true;
  return { username, isAdmin };
}

export function osUserActive(username: string): boolean {
  if (!username) return false;
  try {
    const out = execFileSync("id", ["-u", username], { encoding: "utf8" }).trim();
    return /^\d+$/.test(out);
  } catch {
    return false;
  }
}

export function osUserIsAdmin(username: string): boolean {
  if (!username) return false;
  try {
    const out = execFileSync("id", ["-Gn", username], { encoding: "utf8" }).trim();
    return out.split(/\s+/).includes(ADMIN_GROUP);
  } catch {
    return false;
  }
}

export function parseCookies(header: string | undefined | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  header.split(";").forEach((part) => {
    const idx = part.indexOf("=");
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (!k) return;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      // Malformed %-escape (e.g. a lone "%"): keep the raw value rather than
      // throw, so a crafted Cookie header can't break the upgrade handler.
      out[k] = v;
    }
  });
  return out;
}

export function clientIp(headers: Record<string, string | string[] | undefined>): string {
  const xff = headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) return xff.split(",")[0].trim();
  if (Array.isArray(xff) && xff[0]) return String(xff[0]).split(",")[0].trim();
  return "127.0.0.1";
}

/**
 * Origin check for the WS upgrade. Mirrors terminal: when `allowedOrigin` is
 * unset or "same-origin", require the Origin's host to equal the request's
 * Host (correct behind Caddy/Tailscale where there is no single fixed public
 * origin). A missing / unparseable Origin is rejected. When `allowedOrigin`
 * is a concrete origin, require an exact Origin match.
 */
export function checkOrigin(
  origin: string | undefined,
  host: string | undefined,
  allowedOrigin: string | undefined,
): boolean {
  const sameOriginMode = !allowedOrigin || allowedOrigin === "same-origin";
  if (!sameOriginMode) {
    return origin === allowedOrigin;
  }
  let originHost: string | null = null;
  try {
    originHost = origin ? new URL(origin).host : null;
  } catch {
    originHost = null;
  }
  return Boolean(originHost) && originHost === host;
}

export async function validateSession(
  token: string,
  overrides: Partial<DeriveDeps> = {},
): Promise<{ username: string; isAdmin: boolean } | null> {
  if (!token) return null;
  const pool = requirePool();
  const { rows } = await pool.query<SessionRow>(
    "select u.username, s.last_role_check_at " +
      "from admin_sessions s join pam_users u on u.id = s.user_id " +
      "where s.token = $1 and s.expires_at > now()",
    [token],
  );
  return deriveSessionGrant(rows[0] ?? null, {
    userActive: osUserActive,
    isAdmin: osUserIsAdmin,
    ...overrides,
  });
}
