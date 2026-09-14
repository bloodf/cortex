/**
 * Request context — the per-request lifecycle ported from the legacy SvelteKit
 * `hooks.server.ts` (WP-01).
 *
 * TanStack Start hands a server handler a Web `Request` and expects a `Response`.
 * `resolveContext(request)` does what the SvelteKit hook did:
 *   1. mint a `requestId`, read the `cortexos_session` cookie;
 *   2. resolve it via `getSessionStore().resolveByToken()`; a stale/unknown
 *      token is dropped silently (the session cookie is cleared);
 *   3. re-validate the cached RBAC role if older than ROLE_CHECK_TTL_MS
 *      (60s) via `pam.isAdmin()` + `store.revalidateRole()` — best-effort;
 *   4. touch the rolling 30-day expiry + re-issue the session cookie;
 *   5. populate `ctx.user` / `ctx.session`.
 *
 * `WebCookieJar` accumulates `Set-Cookie` headers on a `Headers` object the
 * caller (`defineApiRoute`) merges into the final `Response`. The framework
 * security headers (`FRAMEWORK_HEADERS`) are exposed for the wrapper to apply.
 *
 * Best-effort rule (SR-001): `resolveContext` never throws on a DB hiccup
 * during touch/role-check — the session stays valid for the current request.
 */

import { randomUUID } from "node:crypto";
import type { Session, User } from "./entities";
import {
  clearSessionCookie,
  getSessionCookie,
  setSessionCookie,
  type CookieJar,
} from "./auth/cookies";
import { DEFAULT_SESSION_TTL_MS, getSessionStore } from "./auth/session-store";
import { getPamAuthenticator } from "./auth/pam";

// ---------------------------------------------------------------------------
// Security headers — applied to every response (ported from hooks.server.ts).
// CSP / HSTS are set at the reverse proxy (Caddy) and are not emitted here.
// ---------------------------------------------------------------------------

export const FRAMEWORK_HEADERS: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

/** TTL between role re-validations. Per SR-011/012, 60s. */
const ROLE_CHECK_TTL_MS = 60_000;

// ---------------------------------------------------------------------------
// Web cookie jar — implements the CookieJar interface over Request/Response.
// ---------------------------------------------------------------------------

interface SetCookieOpts {
  path: string;
  httpOnly?: boolean;
  sameSite?: "lax" | "strict" | "none";
  secure?: boolean;
  maxAge?: number;
}

function parseCookieHeader(header: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  header.split(";").forEach((part) => {
    const idx = part.indexOf("=");
    if (idx >= 0) {
      const name = part.slice(0, idx).trim();
      const value = part.slice(idx + 1).trim();
      if (name) out.set(name, decodeURIComponent(value));
    }
  });
  return out;
}

function serializeSameSite(value: "lax" | "strict" | "none"): string {
  if (value === "lax") return "Lax";
  if (value === "strict") return "Strict";
  return "None";
}

function serializeCookie(name: string, value: string, opts: SetCookieOpts): string {
  const segments = [`${name}=${encodeURIComponent(value)}`];
  segments.push(`Path=${opts.path}`);
  if (opts.maxAge !== undefined) segments.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  if (opts.httpOnly) segments.push("HttpOnly");
  if (opts.sameSite) {
    segments.push(`SameSite=${serializeSameSite(opts.sameSite)}`);
  }
  if (opts.secure) segments.push("Secure");
  return segments.join("; ");
}

/**
 * Reads cookies from the request `Cookie` header and serializes mutations into
 * `Set-Cookie` header strings. `delete` emits a `Max-Age=0` expiry. Pending
 * writes shadow request values so `get` reflects the latest state.
 */
export class WebCookieJar implements CookieJar {
  private readonly incoming: Map<string, string>;
  /** name → latest serialized Set-Cookie string. */
  private readonly pending = new Map<string, string>();
  /** name → latest raw value (or null if deleted) for in-request reads. */
  private readonly overrides = new Map<string, string | null>();

  constructor(request: Request) {
    this.incoming = parseCookieHeader(request.headers.get("cookie"));
  }

  get(name: string, _opts?: { path?: string }): string | undefined {
    if (this.overrides.has(name)) {
      return this.overrides.get(name) ?? undefined;
    }
    return this.incoming.get(name);
  }

  set(name: string, value: string, opts: SetCookieOpts): void {
    this.overrides.set(name, value);
    this.pending.set(name, serializeCookie(name, value, opts));
  }

  delete(name: string, opts?: { path?: string }): void {
    this.overrides.set(name, null);
    this.pending.set(name, serializeCookie(name, "", { path: opts?.path ?? "/", maxAge: 0 }));
  }

  /** Apply accumulated Set-Cookie headers + framework headers to a response. */
  applyTo(headers: Headers): void {
    Array.from(this.pending.values()).forEach((cookie) => {
      headers.append("set-cookie", cookie);
    });
  }
}

// ---------------------------------------------------------------------------
// Request context
// ---------------------------------------------------------------------------

export interface RequestCtx {
  /** The authenticated user, or null. */
  user: User | null;
  /** The resolved session, or null. */
  session: Session | null;
  /** Per-request correlation id. */
  readonly requestId: string;
  /** Best-effort client IP. */
  readonly clientIp: string;
  /** User-Agent header value (or null). */
  readonly userAgent: string | null;
  /** The originating Web request. */
  readonly request: Request;
  /** Cookie jar over the request/response (Set-Cookie accumulates here). */
  readonly cookies: WebCookieJar;
}

function newRequestId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 16);
}

/**
 * Resolve the client IP used for rate-limiting and audit.
 *
 * TRUST MODEL (load-bearing — this is a brute-force defence, not cosmetics):
 * the dashboard binds 127.0.0.1:3080 and is reachable ONLY through Caddy, the
 * sole trusted proxy. Caddy is configured (global `servers.trusted_proxies` +
 * the dashboard `reverse_proxy`) to set `X-Real-IP` to its `{client_ip}` — the
 * real client resolved after stripping trusted-proxy hops (e.g. the tailscale
 * loopback that fronts Caddy). We therefore read ONLY `X-Real-IP`.
 *
 * We must NOT read the raw `X-Forwarded-For`: Caddy/tailscale APPEND the real
 * peer, so the left-hand entries are client-supplied and spoofable. The old
 * `xff.split(',')[0]` took that spoofable left entry, letting an attacker rotate
 * `X-Forwarded-For` to get a fresh login rate-limit bucket per request and
 * defeat PAM brute-force protection (SR / login-ratelimit-bypass-via-spoofed-xff).
 *
 * Fallback: when `X-Real-IP` is absent (a direct loopback request in dev/tests,
 * or a misconfigured proxy) we return loopback rather than trusting attacker
 * input — fail closed to a single shared bucket, never to a spoofable value.
 */
export function readClientIp(request: Request): string {
  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  return "127.0.0.1";
}

/**
 * Resolve the request context: read + validate the session cookie, re-validate
 * the role on a TTL, touch the rolling expiry. Returns a populated `RequestCtx`.
 * Set-Cookie mutations accumulate on `ctx.cookies`; the wrapper applies them.
 */
export async function resolveContext(request: Request): Promise<RequestCtx> {
  const cookies = new WebCookieJar(request);
  const ctx: RequestCtx = {
    user: null,
    session: null,
    requestId: newRequestId(),
    clientIp: readClientIp(request),
    userAgent: request.headers.get("user-agent"),
    request,
    cookies,
  };

  const token = getSessionCookie(cookies);
  if (!token) return ctx;

  const store = getSessionStore();
  const resolved = await store.resolveByToken(token);
  if (!resolved) {
    // Stale/unknown token. Drop the cookie so the browser stops sending it.
    clearSessionCookie(cookies);
    return ctx;
  }

  ctx.user = resolved.user;
  ctx.session = resolved.session;

  // Re-validate role if stale (SR-011/012). Best-effort: PAM may be
  // unavailable (e.g. boot) — keep the cached role on failure.
  const now = Date.now();
  if (now - resolved.session.lastRoleCheckAt > ROLE_CHECK_TTL_MS) {
    try {
      const pam = getPamAuthenticator();
      const isAdmin = await pam.isAdmin(resolved.user.username);
      await store.revalidateRole(token, isAdmin);
    } catch {
      // PAM/DB unavailable — keep the cached role for this request.
    }
  }

  // Touch the rolling expiry + re-issue the cookie. Best-effort.
  try {
    const touched = await store.touch(token, DEFAULT_SESSION_TTL_MS);
    if (touched) {
      setSessionCookie(cookies, token);
    }
  } catch {
    // Touch is best-effort; the session is still valid for this request.
  }

  return ctx;
}

/**
 * Probabilistic session-table GC (~1/1000 requests). Best-effort; never throws.
 * Mirrors the legacy hook's tail GC.
 */
export async function maybeGcExpiredSessions(): Promise<void> {
  if (Math.random() >= 1 / 1000) return;
  try {
    await getSessionStore().gcExpired();
  } catch {
    // best-effort
  }
}
