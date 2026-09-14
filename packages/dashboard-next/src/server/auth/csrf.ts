/**
 * CSRF guard — double-submit cookie verification.
 *
 * Ported from the legacy SvelteKit dashboard (`src/lib/server/auth/csrf.ts`)
 * for the TanStack Start rebuild (WP-01). The check required by THREAT_MODEL
 * SR-004 is unchanged. Every state-changing request must:
 *   1. Carry the session cookie (HttpOnly; set automatically by the browser
 *      on same-origin XHR / form posts).
 *   2. Carry the CSRF cookie (cortexos_csrf) AND echo its value in the
 *      `x-csrf-token` request header.
 *
 * The server compares the two values (cookie vs header) AND the session-bound
 * csrfToken (stored in the `admin_sessions` row). If any of the three is
 * missing or mismatched, the request is rejected with 403.
 *
 * The "session-bound" check is what makes the double-submit pattern strict:
 * a stolen CSRF cookie alone is not enough; the attacker also needs the
 * server-side session, which is in HttpOnly cookies and tied to the DB row.
 *
 * Public API:
 *   - csrfIsSafeMethod(method) → boolean
 *   - csrfHeadersFromRequest(request) → string | null
 *   - requireCsrf(request, expected, jar) → void  (throws ApiErrorThrown)
 *   - LOGIN_BOOTSTRAP_CSRF — the bootstrap token issued on the login page
 *
 * Framework note:
 *   The legacy helper read cookies from a SvelteKit `cookies` object. Here it
 *   reads the header from the Web `Request` and the cookie from the
 *   `CookieJar` adapter the caller supplies (server/context.ts WebCookieJar).
 */

import { CSRF_HEADER, getCsrfCookie, safeCsrfEqual, type CookieJar } from "./cookies";
import { authError, permissionError } from "../errors/types";
import { ApiErrorThrown } from "../errors";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** HTTP methods that do NOT require a CSRF check. */
const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * The "bootstrap" CSRF token issued by the /login page on first visit. The
 * header and cookie must both be this value for the login POST to pass the
 * double-submit check. A real session-bound token replaces it on a
 * successful login.
 */
export const LOGIN_BOOTSTRAP_CSRF = "login-bootstrap";

/** Is the method safe (does not change server state)? */
export function csrfIsSafeMethod(method: string): boolean {
  return SAFE_METHODS.has(method.toUpperCase());
}

/**
 * Pull the CSRF token from the request header. Returns `null` if missing.
 * Used by callers that need to compare manually.
 */
export function csrfHeadersFromRequest(request: Request): string | null {
  return request.headers.get(CSRF_HEADER);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function throwCsrfError(reason: string): never {
  // We do NOT log the reason in production — the audit captures the user +
  // requestId, and we don't want to leak the CSRF diagnostic to a potential
  // attacker. The reason is for unit tests to assert against.
  if (process.env.NODE_ENV !== "production") {
    console.info("[cortexos/csrf] rejected", { reason });
  }
  // For the "missing_session_csrf" case, surface as auth (the caller is
  // unauthenticated and shouldn't be told CSRF exists).
  if (reason === "missing_session_csrf") {
    const err = authError("Authentication required");
    throw new ApiErrorThrown(401, { message: err.message, code: err.kind }, err);
  }
  const err = permissionError("CSRF token invalid or missing");
  throw new ApiErrorThrown(403, { message: err.message, code: err.kind }, err);
}

/**
 * Enforce the CSRF check. On state-changing methods, the request MUST carry:
 *   - a non-empty x-csrf-token header
 *   - a non-empty cortexos_csrf cookie
 *   - both equal to the `expected` session-bound token (typically
 *     `ctx.session?.csrfToken`)
 *
 * On safe methods (GET/HEAD/OPTIONS) this is a no-op.
 *
 * Throws `ApiErrorThrown` (401 for `missing_session_csrf`, 403 otherwise);
 * the `defineApiRoute` wrapper maps it to the typed-error envelope.
 */
export function requireCsrf(request: Request, expected: string | null, jar: CookieJar): void {
  if (csrfIsSafeMethod(request.method)) return;

  const headerToken = csrfHeadersFromRequest(request);
  const cookieValue = getCsrfCookie(jar) ?? "";

  if (!expected) {
    // No session-bound CSRF token — either unauthenticated or the session
    // is missing the field. Treat as 401 (do not reveal CSRF exists to an
    // unauthenticated caller); the route's own auth gate also produces 401.
    throwCsrfError("missing_session_csrf");
  }
  if (!headerToken) {
    throwCsrfError("missing_header");
  }
  if (!cookieValue) {
    throwCsrfError("missing_cookie");
  }
  // Constant-time compare header vs cookie vs session-bound token. A mismatch
  // on any of the three is a fail.
  if (!safeCsrfEqual(headerToken, cookieValue) || !safeCsrfEqual(headerToken, expected)) {
    throwCsrfError("mismatch");
  }
}
