/**
 * RBAC predicates + require* helpers.
 *
 * Ported from the legacy SvelteKit dashboard (`src/lib/server/auth/index.ts`)
 * for the TanStack Start rebuild (WP-01). The RBAC predicates (`isAdmin`,
 * `hasGroup`) are unchanged — `cortexos-admin` is the ONLY admin-bearing
 * group (THREAT_MODEL SR-003: sudo/wheel MUST NOT grant admin).
 *
 * The `requireAuth`/`requireAdmin`/`requireGroup` family is rewritten to read
 * from the request `RequestCtx` (built by `resolveContext`) instead of the
 * SvelteKit `event.locals`. They throw `ApiErrorThrown` (401/403) which the
 * `defineApiRoute` wrapper maps to the typed-error envelope.
 */

import type { GroupName, User } from "../entities";
import { authError, permissionError } from "../errors/types";
import { ApiErrorThrown } from "../errors";
import type { RequestCtx } from "../context";

// ---------------------------------------------------------------------------
// RBAC predicates — single source of truth (SR-003)
// ---------------------------------------------------------------------------

/**
 * `isAdmin` returns `true` iff the user is a member of `cortexos-admin`.
 * `sudo` and `wheel` MUST NOT grant admin (THREAT_MODEL SR-003).
 */
export function isAdmin(user: User): boolean {
  // The runtime User can be either shape (string union from the legacy auth
  // store, or contracts-shape object).
  if (user.isAdmin === true) return true;
  if ((user as { is_admin?: boolean }).is_admin === true) return true;
  return user.groupMemberships.some((g) =>
    typeof g === "string" ? g === "cortexos-admin" : g.name === "cortexos-admin",
  );
}

/** Does the user hold a given group membership? */
export function hasGroup(user: User, group: GroupName): boolean {
  return user.groupMemberships.some((g) =>
    typeof g === "string" ? g === group : g.name === group,
  );
}

// ---------------------------------------------------------------------------
// require* helpers — throw ApiErrorThrown on failure
// ---------------------------------------------------------------------------

function throwAuth(message = "Authentication required"): never {
  const err = authError(message);
  throw new ApiErrorThrown(401, { message: err.message, code: err.kind }, err);
}

function throwPermission(message: string): never {
  const err = permissionError(message);
  throw new ApiErrorThrown(403, { message: err.message, code: err.kind }, err);
}

/**
 * Ensure the request is authenticated. Returns the user on success; otherwise
 * throws a 401 (no session) — an inactive account is also a 401.
 */
export function requireAuth(ctx: RequestCtx): User {
  const { user } = ctx;
  if (!user) throwAuth();
  if (!user.isActive) throwAuth("Account is inactive");
  return user;
}

/**
 * Ensure the request is authenticated AND the user is an admin. Returns the
 * user on success; otherwise throws 401 (unauthenticated) or 403
 * (authenticated but not admin).
 */
export function requireAdmin(ctx: RequestCtx): User {
  const user = requireAuth(ctx);
  if (!isAdmin(user)) throwPermission("Admin role required");
  return user;
}

/**
 * Ensure the request is authenticated AND the user is in `group`. Returns the
 * user on success; otherwise throws 401/403.
 */
export function requireGroup(ctx: RequestCtx, group: GroupName): User {
  const user = requireAuth(ctx);
  if (!hasGroup(user, group)) throwPermission(`Group '${group}' required`);
  return user;
}
