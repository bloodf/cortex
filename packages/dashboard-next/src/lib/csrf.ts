/**
 * Client-side CSRF helper for admin mutations (WP-40).
 *
 * Transport is createServerFn RPC (ADR-001). Mutations (POST server fns) must
 * carry the session-bound CSRF token in the `x-csrf-token` header so the
 * server pipeline's double-submit check passes (it compares header vs the
 * JS-readable `cortexos_csrf` cookie vs the session-bound token). The session
 * cookie is HttpOnly and rides along automatically; only the CSRF header is the
 * caller's responsibility.
 *
 * The CSRF cookie name mirrors `src/server/config.ts` CSRF_COOKIE. We do NOT
 * import from `src/server/**` (server-only) — the literal is duplicated here on
 * purpose to keep this file client-safe.
 */

const CSRF_COOKIE = "cortexos_csrf";
const CSRF_HEADER = "x-csrf-token";

/** Read the JS-readable CSRF cookie. Returns `null` if missing (SSR or no session). */
export function readCsrfToken(): string | null {
  if (typeof document === "undefined") return null;
  const part = document.cookie.split(";").find((p) => p.trim().startsWith(`${CSRF_COOKIE}=`));
  if (!part) return null;
  return decodeURIComponent(part.trim().slice(CSRF_COOKIE.length + 1));
}

/**
 * Build the header map for a mutating server-fn call. The createServerFn
 * fetcher accepts a `headers` option (`{ data, headers }`); pass the result of
 * this through it so the pipeline's CSRF gate is satisfied.
 */
export function csrfHeaders(): Record<string, string> {
  const token = readCsrfToken();
  return token ? { [CSRF_HEADER]: token } : {};
}
