/**
 * Cookie helpers — session + CSRF (double-submit).
 *
 * Ported from the legacy SvelteKit dashboard (`src/lib/server/auth/cookies.ts`)
 * for the TanStack Start rebuild (WP-01). The cookie semantics are unchanged:
 *
 *   SESSION COOKIE
 *     Name:     cortexos_session
 *     Value:    server-generated 32-byte CSPRNG token, base64url
 *     HttpOnly: yes  (JS cannot read it; XSS-resistant)
 *     SameSite: Lax  (top-level navigations allowed; CSRF safe for
 *                      state-changing POSTs from cross-origin pages)
 *     Secure:   yes  in production (NODE_ENV=production). NOT in dev
 *               so http://localhost works.
 *     Path:     /
 *     Max-Age:  30 days (rolling — `resolveContext` touches the
 *               server-side expires_at on every authenticated request
 *               and the cookie is re-issued with the new Max-Age)
 *
 *   CSRF COOKIE (double-submit pattern, THREAT_MODEL SR-004)
 *     Name:     cortexos_csrf
 *     Value:    mirror of the session's csrfToken
 *     HttpOnly: NO   (JS must read it to echo it in the x-csrf-token
 *                      header on state-changing requests)
 *     SameSite: Lax
 *     Secure:   yes  in production
 *     Path:     /
 *     Max-Age:  30 days
 *
 * Why double-submit:
 *   The CSRF cookie is readable from JS (so the SPA can read it and
 *   echo it in a header). The session cookie is HttpOnly (XSS-safe).
 *   A cross-origin attacker who tricks the browser into a state-
 *   changing POST can attach cookies automatically, but cannot read
 *   the CSRF cookie to forge the header. The server compares the
 *   header to the cookie (and to the value bound to the session in
 *   the DB) — a missing-or-mismatched header → 403.
 *
 * Production-cookie rule:
 *   The Secure attribute is omitted in non-production (NODE_ENV !==
 *   'production') so the dev server on http://localhost can set the
 *   cookie. In production, Secure is always set; TLS terminates at
 *   the reverse proxy.
 *
 * Framework adapter:
 *   SvelteKit handed the route a `cookies` object. TanStack Start gives
 *   us a Web `Request`/`Response`. `WebCookieJar` (in `server/context.ts`)
 *   implements this same `CookieJar` interface over those primitives, so
 *   the cookie helpers below are ported verbatim.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { CSRF_COOKIE, SESSION_COOKIE } from "../config";

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/** Default session lifetime, in seconds, for the cookie `Max-Age`. */
export const SESSION_MAX_AGE_SEC = 30 * 24 * 60 * 60; // 30 days

/** Default CSRF cookie lifetime, in seconds. */
export const CSRF_MAX_AGE_SEC = 30 * 24 * 60 * 60; // 30 days

/** The CSRF header the client sends on state-changing requests. */
export const CSRF_HEADER = "x-csrf-token";

// ---------------------------------------------------------------------------
// Cookie jar interface (subset)
// ---------------------------------------------------------------------------

/**
 * Minimal cookie interface — just the methods we use. The `WebCookieJar`
 * adapter (server/context.ts) reads from the request `Cookie` header and
 * accumulates `Set-Cookie` headers on the response. `get` returns the raw
 * value (matches the legacy SvelteKit `Cookies`).
 */
/** Minimal cookie options the jar helpers actually read. */
export interface CookieOpts {
  path?: string;
}

export interface CookieJar {
  get(name: string, opts?: CookieOpts): string | undefined;
  set(
    name: string,
    value: string,
    opts: {
      path: string;
      httpOnly?: boolean;
      sameSite?: "lax" | "strict" | "none";
      secure?: boolean;
      maxAge?: number;
    },
  ): void;
  delete(name: string, opts?: CookieOpts): void;
}

// ---------------------------------------------------------------------------
// Token generation
// ---------------------------------------------------------------------------

/** Generate a fresh CSRF token. 32 bytes of CSPRNG, base64url. */
export function generateCsrfToken(): string {
  return randomBytes(32).toString("base64url");
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

// ---------------------------------------------------------------------------
// Session cookie
// ---------------------------------------------------------------------------

/**
 * Set the session cookie. `token` is the server-generated value returned
 * by `SessionStore.createSession()`. The cookie is HttpOnly; JS cannot read
 * it. `Max-Age` is set to the rolling TTL so the browser aligns its eviction
 * with the server's `expires_at`.
 */
export function setSessionCookie(
  jar: CookieJar,
  token: string,
  opts: { maxAgeSec?: number; secure?: boolean } = {},
): void {
  jar.set(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: opts.secure ?? isProduction(),
    maxAge: opts.maxAgeSec ?? SESSION_MAX_AGE_SEC,
  });
}

/** Read the session cookie value. Returns `null` if missing. */
export function getSessionCookie(jar: CookieJar): string | null {
  return jar.get(SESSION_COOKIE, { path: "/" }) ?? null;
}

/** Clear the session cookie. Idempotent. */
export function clearSessionCookie(jar: CookieJar): void {
  jar.delete(SESSION_COOKIE, { path: "/" });
}

// ---------------------------------------------------------------------------
// CSRF cookie (double-submit)
// ---------------------------------------------------------------------------

/**
 * Set the CSRF cookie. `token` MUST equal the `csrfToken` bound to the
 * current session. The cookie is NOT HttpOnly — the SPA reads it and echoes
 * it in the `x-csrf-token` header.
 */
export function setCsrfCookie(
  jar: CookieJar,
  token: string,
  opts: { maxAgeSec?: number; secure?: boolean } = {},
): void {
  jar.set(CSRF_COOKIE, token, {
    path: "/",
    httpOnly: false,
    sameSite: "lax",
    secure: opts.secure ?? isProduction(),
    maxAge: opts.maxAgeSec ?? CSRF_MAX_AGE_SEC,
  });
}

/** Read the CSRF cookie value. Returns `null` if missing. */
export function getCsrfCookie(jar: CookieJar): string | null {
  return jar.get(CSRF_COOKIE, { path: "/" }) ?? null;
}

/** Clear the CSRF cookie. Idempotent. */
export function clearCsrfCookie(jar: CookieJar): void {
  jar.delete(CSRF_COOKIE, { path: "/" });
}

// ---------------------------------------------------------------------------
// Verification helper
// ---------------------------------------------------------------------------

/**
 * Compare a candidate CSRF token to the canonical value using a constant-time
 * string comparison. The two values should be the same length (both base64url
 * 32-byte CSPRNG); a length mismatch is treated as a fail.
 */
export function safeCsrfEqual(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false;
  if (a.length !== b.length) return false;
  // Constant-time comparison via crypto.timingSafeEqual.
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
