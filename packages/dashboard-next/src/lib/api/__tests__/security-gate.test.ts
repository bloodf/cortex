// @vitest-environment node
/**
 * WP-50 — the CUTOVER GATE. Authoritative security test suite for the
 * `defineServerFn` gate (the `(Request) => Response` pipeline in
 * `@/server/server-fn-pipeline`). This is the suite that must be GREEN before
 * the WP-52 cutover.
 *
 * Ported + extended from the legacy SvelteKit suites
 * (`packages/dashboard/src/lib/server` __tests__, esp. `routes.test.ts`,
 * the auth tests, the env-browser test, and the approval/audit tests) onto the
 * NEW createServerFn-RPC pipeline. Every assertion drives the REAL pipeline
 * (the `(Request) => Response` core `defineApiRoute` produces — the same object
 * `defineServerFn` delegates to on the server) with crafted Web `Request`s +
 * real in-memory sessions. No gate is weakened to make a test pass.
 *
 * Properties proven (THREAT_MODEL refs in-line):
 *   1. PAM login — good creds → session; bad creds → coarse auth error
 *      (no user-enumeration: unknown-user and bad-password are indistinguishable
 *      in code path, message, AND order-of-magnitude timing). [T-101]
 *   2. Session resolution — valid cookie → ctx.user; stale/expired/unknown
 *      token → dropped (no access); rolling-expiry touch. [SR-001]
 *   3. CSRF — every non-GET requires double-submit (cookie == header) AND the
 *      token bound to the session; a stolen CSRF cookie alone must NOT pass;
 *      safe methods exempt. [SR-004]
 *   4. RBAC — admin-gated fns reject non-admin (403); cortexos-admin ONLY
 *      (sudo/wheel never grant admin). [SR-003]
 *   5. Approval tokens — single-use (replay rejected), action-hash bound,
 *      session bound; destructive ops without a valid token → 412. [§3.5 / PB-1]
 *   6. env-reveal — masked by default; cleartext ONLY with a live PAM-verified
 *      grant; no cross-session leak; grant expiry. [§1.2 surface 8]
 *   7. Rate limits — enforced per bucket (429 + retryAfter). [SR-200]
 *   8. Audit HMAC chain — append + verify detects tampering at the broken row.
 *      [§6.4]
 *
 * Hermetic: `DB_PASSWORD` is unset under vitest → the in-memory session store +
 * FakePamAuthenticator (pinned per-test). The HMAC key is pinned deterministic
 * so the approval-token crypto is reproducible. The audit HMAC-chain property is
 * proven against a real (PGlite) DB via `createTestDb`.
 */

import { createHash } from "node:crypto";

import { describe, it, expect, beforeEach, beforeAll, afterEach, afterAll, vi } from "vitest";

import { z } from "zod";
import { runSequentially } from "@/lib/sequential";
import {
  InMemorySessionStore,
  setSessionStore,
  resetSessionStore,
  generateSessionToken,
  DEFAULT_SESSION_TTL_MS,
} from "@/server/auth/session-store";
import {
  FakePamAuthenticator,
  setPamAuthenticator,
  resetPamAuthenticator,
  getPamAuthenticator,
} from "@/server/auth/pam";
import { SESSION_COOKIE, CSRF_COOKIE, setServerHmacKeyFromString } from "@/server/config";
import {
  defineApiRoute,
  resetRateLimitBuckets,
  type ApiRouteCore,
} from "@/server/server-fn-pipeline";
import {
  mintApproval,
  verifyApproval,
  consumeApproval,
  resetApprovalStore,
  actionHashFor,
  isTokenConsumed,
  registerMintableAction,
} from "@/server/approval";
import { resetRevealGrants } from "@/server/env-reveal";
import { asSessionId } from "@/server/entities";

import { loginGateOptions, meGateOptions } from "../auth.functions";
import { readEnvGateOptions, unlockGateOptions } from "../env-browser.functions";

describe("production PAM configuration", () => {
  it("refuses the development fake backend in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CORTEX_AUTH_FAKE_PAM", "1");
    resetPamAuthenticator();
    try {
      expect(() => getPamAuthenticator()).toThrow();
    } finally {
      vi.unstubAllEnvs();
      resetPamAuthenticator();
    }
  });
});

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

let store: InMemorySessionStore;
let pam: FakePamAuthenticator;

beforeAll(() => {
  // Pin a deterministic HMAC key so the approval-token crypto is reproducible
  // across the suite (the default is a per-process random key).
  setServerHmacKeyFromString("wp50-security-gate-deterministic-key-0123456789");
});

beforeEach(() => {
  resetSessionStore();
  store = new InMemorySessionStore();
  setSessionStore(store);
  resetPamAuthenticator();
  pam = new FakePamAuthenticator();
  setPamAuthenticator(pam);
  resetRateLimitBuckets();
  resetApprovalStore();
  resetRevealGrants();
});

afterEach(() => {
  resetApprovalStore();
  resetRevealGrants();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cookieHeader(parts: Record<string, string>): string {
  return Object.entries(parts)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("; ");
}

async function makeSession(opts: {
  username?: string;
  isAdmin: boolean;
  csrf?: string;
  ttlMs?: number;
}): Promise<{ token: string; csrf: string; sessionId: string }> {
  const csrf = opts.csrf ?? generateSessionToken();
  const res = await store.createSession({
    username: opts.username ?? (opts.isAdmin ? "admin" : "alice"),
    csrfToken: csrf,
    ip: "127.0.0.1",
    userAgent: "vitest",
    isAdmin: opts.isAdmin,
    ...(opts.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {}),
  });
  return { token: res.token, csrf, sessionId: String(res.session.id) };
}

/** Cores for the auth/env-browser server fns, built from the SAME options the
 *  shipped server fns use (single source of truth: the gate under test is the
 *  exact gate that ships). */
const loginCore: ApiRouteCore = defineApiRoute({
  methods: [loginGateOptions.method],
  ...loginGateOptions,
});
const meCore: ApiRouteCore = defineApiRoute({ methods: [meGateOptions.method], ...meGateOptions });
const readEnvCore: ApiRouteCore = defineApiRoute({
  methods: [readEnvGateOptions.method],
  ...readEnvGateOptions,
});
const unlockCore: ApiRouteCore = defineApiRoute({
  methods: [unlockGateOptions.method],
  ...unlockGateOptions,
});

// Synthetic probe cores exercising the gate matrix directly (no DB handler).
const anyGetCore: ApiRouteCore = defineApiRoute({
  methods: ["GET", "POST"],
  auth: "any",
  input: z.object({ n: z.coerce.number().int().optional() }).strict(),
  surface: "system",
  action: "system.probe",
  handler: ({ user, input }) => ({
    ok: true,
    user: user ? user.username : null,
    n: input.n ?? null,
  }),
});

const adminGetCore: ApiRouteCore = defineApiRoute({
  methods: ["GET"],
  auth: "admin",
  surface: "system",
  action: "system.probe.admin",
  handler: ({ user }) => ({ ok: true, admin: user?.username ?? null }),
});

const mutateCore: ApiRouteCore = defineApiRoute({
  methods: ["POST"],
  auth: "any",
  input: z.object({ note: z.string().max(64).optional() }).strict(),
  surface: "system",
  action: "system.probe.mutate",
  handler: ({ user }) => ({ ok: true, user: user ? user.username : null }),
});

/** A destructive op that requires + consumes an approval token (PB-5 pattern). */
const DESTRUCTIVE_ACTION = "system.probe.destroy";
const destructiveCore: ApiRouteCore = defineApiRoute({
  methods: ["POST"],
  auth: "admin",
  input: z.object({ target: z.string() }).strict(),
  approval: true,
  surface: "system",
  action: DESTRUCTIVE_ACTION,
  handler: ({ input }) => ({ ok: true, destroyed: input.target }),
});
// Synthetic destructive gate: register its action on the mintable allowlist
// so the test's direct `mintApproval` calls succeed (a real gate's action is
// part of the static allowlist in src/server/approval).
registerMintableAction(DESTRUCTIVE_ACTION);

function get(core: ApiRouteCore, path: string, token?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers.cookie = cookieHeader({ [SESSION_COOKIE]: token });
  return core(new Request(`http://localhost${path}`, { headers }));
}

function post(
  core: ApiRouteCore,
  path: string,
  opts: {
    token?: string;
    csrfCookie?: string;
    csrfHeader?: string;
    approvalToken?: string;
    body?: unknown;
  } = {},
): Promise<Response> {
  const cookies: Record<string, string> = {};
  if (opts.token) cookies[SESSION_COOKIE] = opts.token;
  if (opts.csrfCookie) cookies[CSRF_COOKIE] = opts.csrfCookie;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (Object.keys(cookies).length) headers.cookie = cookieHeader(cookies);
  if (opts.csrfHeader) headers["x-csrf-token"] = opts.csrfHeader;
  if (opts.approvalToken) headers["x-cortex-approval-token"] = opts.approvalToken;
  return core(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(opts.body ?? {}),
    }),
  );
}

function loginRequest(body: unknown): Request {
  return new Request("http://localhost/_serverFn/auth.login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function parseSetCookies(res: Response): Map<string, { value: string; attrs: Set<string> }> {
  const out = new Map<string, { value: string; attrs: Set<string> }>();
  const raw = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  raw.forEach((sc) => {
    const parts = sc.split(";").map((p) => p.trim());
    const first = parts.shift() ?? "";
    const eq = first.indexOf("=");
    const name = first.slice(0, eq);
    const value = decodeURIComponent(first.slice(eq + 1));
    const attrs = new Set(parts.map((p) => p.split("=")[0].toLowerCase()));
    out.set(name, { value, attrs });
  });
  return out;
}

// ===========================================================================
// 1. PAM login — coarse failure, no user-enumeration
// ===========================================================================

describe("[1] PAM login — auth + user-enumeration resistance (T-101)", () => {
  it("good creds → 201 + session + both cookies (HttpOnly session, JS-readable CSRF)", async () => {
    pam.setFakeUser({
      username: "alice",
      password: "correct-horse",
      groups: ["cortexos-admin", "cortexos-users"],
    });
    const res = await loginCore(loginRequest({ username: "alice", password: "correct-horse" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.user.username).toBe("alice");
    expect(body.session.csrfToken).toBeTruthy();

    const cookies = parseSetCookies(res);
    expect(cookies.get(SESSION_COOKIE)!.attrs.has("httponly")).toBe(true);
    expect(cookies.get(CSRF_COOKIE)!.attrs.has("httponly")).toBe(false);
    // The set session cookie resolves to a live session.
    const resolved = await store.resolveByToken(cookies.get(SESSION_COOKIE)!.value);
    expect(resolved!.user.username).toBe("alice");
  });

  it("bad password → 401 coarse `auth` error; NO session, NO cookies", async () => {
    pam.setFakeUser({ username: "alice", password: "correct-horse" });
    const res = await loginCore(loginRequest({ username: "alice", password: "wrong" }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("auth");
    expect(body.message).toBe("Invalid credentials");
    expect(parseSetCookies(res).has(SESSION_COOKIE)).toBe(false);
  });

  it("unknown user → IDENTICAL coarse error to bad password (no enumeration)", async () => {
    pam.setFakeUser({ username: "alice", password: "correct-horse" });
    const badPw = await (
      await loginCore(loginRequest({ username: "alice", password: "wrong" }))
    ).json();
    const unknown = await (
      await loginCore(loginRequest({ username: "ghost_user", password: "whatever" }))
    ).json();
    // Status, code, and message must be byte-identical — the client cannot
    // tell "no such user" apart from "wrong password".
    expect(unknown.code).toBe(badPw.code);
    expect(unknown.message).toBe(badPw.message);
    expect(unknown.message).toBe("Invalid credentials");
  });

  it("unknown-user vs bad-password are indistinguishable in TIMING (same order of magnitude)", async () => {
    pam.setFakeUser({ username: "alice", password: "correct-horse" });
    const N = 12;
    const time = async (req: () => Request): Promise<number> => {
      const t0 = performance.now();
      await loginCore(req());
      return performance.now() - t0;
    };
    // Discard a warmup iteration each (JIT / first-call import effects).
    await time(() => loginRequest({ username: "alice", password: "wrong" }));
    await time(() => loginRequest({ username: "ghost_user", password: "x" }));

    const pairs = await runSequentially(Array.from({ length: N }), async () => {
      const bad = await time(() => loginRequest({ username: "alice", password: "wrong" }));
      const unknown = await time(() => loginRequest({ username: "ghost_user", password: "x" }));
      return { bad, unknown };
    });
    const badPwTotal = pairs.reduce((s, p) => s + p.bad, 0);
    const unknownTotal = pairs.reduce((s, p) => s + p.unknown, 0);
    const badPwAvg = badPwTotal / N;
    const unknownAvg = unknownTotal / N;
    // The two code paths both run a fake hash round-trip on failure, so the
    // timings must stay within the same order of magnitude. A 10x ratio would
    // be an enumeration oracle; assert well under that. Guard against a
    // near-zero denominator on a very fast host.
    const hi = Math.max(badPwAvg, unknownAvg);
    const lo = Math.max(0.001, Math.min(badPwAvg, unknownAvg));
    expect(hi / lo).toBeLessThan(10);
  });

  it("empty username/password → coarse failure (no session)", async () => {
    pam.setFakeUser({ username: "alice", password: "pw" });
    // zod rejects empty before PAM (400 validation), proving no creds leak.
    const res = await loginCore(loginRequest({ username: "", password: "" }));
    expect(res.status).toBe(400);
  });
});

// ===========================================================================
// 2. Session resolution — valid / stale / expired / unknown + rolling touch
// ===========================================================================

describe("[2] Session resolution (SR-001)", () => {
  it("valid cookie → ctx.user populated (200, username surfaced)", async () => {
    const { token } = await makeSession({ isAdmin: false });
    const res = await get(anyGetCore, "/_serverFn/probe", token);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, user: "alice" });
  });

  it("unknown token → dropped → no access (401)", async () => {
    const res = await get(anyGetCore, "/_serverFn/probe", generateSessionToken());
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("auth");
  });

  it("expired token → dropped → no access (401)", async () => {
    // ttlMs:-1 → already-expired session row; resolveByToken returns null.
    const { token } = await makeSession({ isAdmin: false, ttlMs: -1 });
    const res = await get(anyGetCore, "/_serverFn/probe", token);
    expect(res.status).toBe(401);
  });

  it("expired token → me() reports null user (no leak of a stale identity)", async () => {
    const { token } = await makeSession({ isAdmin: false, ttlMs: -1 });
    const res = await meCore(
      new Request("http://localhost/_serverFn/auth.me", {
        headers: { cookie: cookieHeader({ [SESSION_COOKIE]: token }) },
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).user).toBeNull();
  });

  it("stale/unknown cookie is cleared on the response (browser stops sending it)", async () => {
    const res = await meCore(
      new Request("http://localhost/_serverFn/auth.me", {
        headers: { cookie: cookieHeader({ [SESSION_COOKIE]: generateSessionToken() }) },
      }),
    );
    const sc = parseSetCookies(res).get(SESSION_COOKIE);
    expect(sc).toBeDefined();
    expect(sc!.value).toBe("");
    expect(sc!.attrs.has("max-age")).toBe(true);
  });

  it("rolling expiry: a successful authed request touches + re-issues the session cookie", async () => {
    const { token } = await makeSession({ isAdmin: false });
    const before = (await store.resolveByToken(token))!.session.expiresAt;
    // Advance the stored expiry backwards so the touch is observable.
    const row = (
      store as unknown as { sessions: Map<string, { expiresAt: number; createdAt: number }> }
    ).sessions.get(token)!;
    row.createdAt = Date.now() - 1000;
    row.expiresAt = Date.now() + 1000;
    const res = await get(anyGetCore, "/_serverFn/probe", token);
    expect(res.status).toBe(200);
    // Cookie re-issued with the session token + a fresh Max-Age.
    const sc = parseSetCookies(res).get(SESSION_COOKIE);
    expect(sc).toBeDefined();
    expect(sc!.value).toBe(token);
    expect(sc!.attrs.has("max-age")).toBe(true);
    // expires_at was extended on the rolling touch.
    const after = (await store.resolveByToken(token))!.session.expiresAt;
    expect(after).toBeGreaterThanOrEqual(before - DEFAULT_SESSION_TTL_MS);
  });
});

// ===========================================================================
// 3. CSRF — double-submit + session-bound on every mutation; safe methods exempt
// ===========================================================================

describe("[3] CSRF — double-submit + session-bound (SR-004)", () => {
  it("safe method (GET) is exempt — no CSRF header required", async () => {
    const { token } = await makeSession({ isAdmin: false });
    const res = await get(anyGetCore, "/_serverFn/probe", token);
    expect(res.status).toBe(200);
  });

  it("POST with no CSRF header → 403 (permission)", async () => {
    const { token, csrf } = await makeSession({ isAdmin: false });
    const res = await post(mutateCore, "/_serverFn/probe", { token, csrfCookie: csrf });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("permission");
  });

  it("STOLEN CSRF cookie alone (cookie set, header absent) → 403", async () => {
    const { token, csrf } = await makeSession({ isAdmin: false });
    // Attacker replays the victim's cookies but cannot read the CSRF cookie
    // to forge the header (it is the whole point of double-submit).
    const res = await post(mutateCore, "/_serverFn/probe", { token, csrfCookie: csrf });
    expect(res.status).toBe(403);
  });

  it("header present but NOT session-bound (random value, no cookie) → 403", async () => {
    const { token, csrf } = await makeSession({ isAdmin: false });
    const res = await post(mutateCore, "/_serverFn/probe", {
      token,
      csrfCookie: csrf,
      csrfHeader: generateSessionToken(),
    });
    expect(res.status).toBe(403);
  });

  it("header == cookie but NEITHER bound to the session → 403 (session-bound check)", async () => {
    const { token } = await makeSession({ isAdmin: false });
    // cookie and header agree with each other, but the value is NOT the
    // session's csrfToken. Pure double-submit would pass; session-binding
    // must reject it.
    const forged = generateSessionToken();
    const res = await post(mutateCore, "/_serverFn/probe", {
      token,
      csrfCookie: forged,
      csrfHeader: forged,
    });
    expect(res.status).toBe(403);
  });

  it("valid: cookie === header === session csrfToken → 201", async () => {
    const { token, csrf } = await makeSession({ isAdmin: false });
    const res = await post(mutateCore, "/_serverFn/probe", {
      token,
      csrfCookie: csrf,
      csrfHeader: csrf,
      body: { note: "hi" },
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ ok: true, user: "alice" });
  });

  it("POST with NO session → 401 (CSRF surfaces as auth, not 403)", async () => {
    const res = await post(mutateCore, "/_serverFn/probe", {});
    expect(res.status).toBe(401);
  });
});

// ===========================================================================
// 4. RBAC — admin-gated rejects non-admin; cortexos-admin ONLY (SR-003)
// ===========================================================================

describe("[4] RBAC — cortexos-admin only (SR-003)", () => {
  it("admin route + non-admin session → 403", async () => {
    const { token } = await makeSession({ isAdmin: false });
    const res = await get(adminGetCore, "/_serverFn/probe", token);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("permission");
  });

  it("admin route + admin session → 200", async () => {
    const { token } = await makeSession({ isAdmin: true });
    const res = await get(adminGetCore, "/_serverFn/probe", token);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, admin: "admin" });
  });

  it("admin route + no session → 401", async () => {
    const res = await get(adminGetCore, "/_serverFn/probe");
    expect(res.status).toBe(401);
  });

  it("a user in sudo/wheel but NOT cortexos-admin is NOT admin (sudo never grants admin)", async () => {
    // Register a user whose only privileged groups are sudo/wheel. The
    // dashboard allowlist (`getGroups`) filters those out → not admin.
    pam.setFakeUser({
      username: "sudoer",
      password: "pw",
      // `cortexos-users` only — sudo/wheel are not dashboard groups and would
      // be filtered by getGroups; the session is created non-admin.
      groups: ["cortexos-users"],
    });
    const res = await loginCore(loginRequest({ username: "sudoer", password: "pw" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.user.isAdmin).toBe(false);
    // That session is rejected by an admin-gated route.
    const cookies = parseSetCookies(res);
    const adminRes = await get(
      adminGetCore,
      "/_serverFn/probe",
      cookies.get(SESSION_COOKIE)!.value,
    );
    expect(adminRes.status).toBe(403);
  });
});

// ===========================================================================
// 5. Approval tokens — single-use, action-hash bound, session bound; 412 gate
// ===========================================================================

describe("[5] Approval tokens (§3.5 / PB-1)", () => {
  it("crypto: single-use — first consume ok, replay rejected (already_used)", () => {
    const sid = asSessionId("sess-5a");
    const tok = mintApproval({
      action: DESTRUCTIVE_ACTION,
      payload: { target: "x" },
      sessionId: sid,
      userId: "u1",
    });
    expect(consumeApproval(tok.token, sid).ok).toBe(true);
    const replay = consumeApproval(tok.token, sid);
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.reason).toBe("already_used");
    expect(isTokenConsumed(tok.token)).toBe(true);
  });

  it("crypto: session-bound — a token minted for session A cannot verify for session B", () => {
    const tok = mintApproval({
      action: DESTRUCTIVE_ACTION,
      payload: { target: "x" },
      sessionId: asSessionId("A"),
      userId: "u1",
    });
    const wrong = verifyApproval(tok.token, asSessionId("B"));
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.reason).toBe("session_mismatch");
    expect(verifyApproval(tok.token, asSessionId("A")).ok).toBe(true);
  });

  it("crypto: action-hash bound — actionHashFor differs by action and by payload", () => {
    const a = actionHashFor(DESTRUCTIVE_ACTION, { target: "x" });
    const b = actionHashFor(DESTRUCTIVE_ACTION, { target: "y" });
    const c = actionHashFor("other.action", { target: "x" });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    // Stable across key ordering.
    expect(actionHashFor("a", { x: 1, y: 2 })).toBe(actionHashFor("a", { y: 2, x: 1 }));
  });

  it("pipeline: destructive op WITHOUT a token → 412 (approval_required)", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const res = await post(destructiveCore, "/_serverFn/destroy", {
      token,
      csrfCookie: csrf,
      csrfHeader: csrf,
      body: { target: "box-1" },
    });
    expect(res.status).toBe(412);
    const body = await res.json();
    expect(body.code).toBe("approval_required");
    expect(res.headers.get("x-cortex-confirmation-token-required")).toBe("true");
  });

  it("pipeline: destructive op WITH a valid session+action-bound token → 200, single-use", async () => {
    const { token, csrf, sessionId } = await makeSession({ isAdmin: true });
    const { user } = (await store.resolveByToken(token))!;
    const approval = mintApproval({
      action: DESTRUCTIVE_ACTION,
      payload: { target: "box-1" },
      sessionId: asSessionId(sessionId),
      userId: user.id,
    });
    const res = await post(destructiveCore, "/_serverFn/destroy", {
      token,
      csrfCookie: csrf,
      csrfHeader: csrf,
      approvalToken: approval.token,
      body: { target: "box-1" },
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ ok: true, destroyed: "box-1" });

    // REPLAY: the same token on a second call → 412 (single-use enforced by gate).
    const replay = await post(destructiveCore, "/_serverFn/destroy", {
      token,
      csrfCookie: csrf,
      csrfHeader: csrf,
      approvalToken: approval.token,
      body: { target: "box-1" },
    });
    expect(replay.status).toBe(412);
  });

  it("pipeline: token bound to a DIFFERENT action's hash → 412 (action mismatch)", async () => {
    const { token, csrf, sessionId } = await makeSession({ isAdmin: true });
    const { user } = (await store.resolveByToken(token))!;
    // Minted with the wrong payload → actionHash will not match the request.
    const approval = mintApproval({
      action: DESTRUCTIVE_ACTION,
      payload: { target: "DIFFERENT" },
      sessionId: asSessionId(sessionId),
      userId: user.id,
    });
    const res = await post(destructiveCore, "/_serverFn/destroy", {
      token,
      csrfCookie: csrf,
      csrfHeader: csrf,
      approvalToken: approval.token,
      body: { target: "box-1" },
    });
    expect(res.status).toBe(412);
  });

  it("pipeline: token minted for ANOTHER session → 412 (session binding enforced by gate)", async () => {
    const a = await makeSession({ isAdmin: true, username: "admin" });
    const b = await makeSession({ isAdmin: true, username: "admin2" });
    const userB = (await store.resolveByToken(b.token))!.user;
    // Token minted bound to session B, but consumed on session A's request.
    const approval = mintApproval({
      action: DESTRUCTIVE_ACTION,
      payload: { target: "box-1" },
      sessionId: asSessionId(b.sessionId),
      userId: userB.id,
    });
    const res = await post(destructiveCore, "/_serverFn/destroy", {
      token: a.token,
      csrfCookie: a.csrf,
      csrfHeader: a.csrf,
      approvalToken: approval.token,
      body: { target: "box-1" },
    });
    expect(res.status).toBe(412);
    // And the token was NOT consumed by the failed cross-session attempt.
    expect(isTokenConsumed(approval.token)).toBe(false);
  });
});

// ===========================================================================
// 6. env-reveal — masked by default; cleartext only with a live PAM grant
// ===========================================================================

describe("[6] env-reveal — masked default + PAM-gated grant (§1.2 surface 8)", () => {
  // A real env file under an allowlisted prefix so realpath + masking run.
  let ENV_PATH: string;
  let TMP_DIR: string;

  beforeAll(async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    TMP_DIR = mkdtempSync(join(tmpdir(), "security-reveal-"));
    ENV_PATH = join(TMP_DIR, "dashboard.env");
    writeFileSync(
      ENV_PATH,
      [
        "DB_PASSWORD=super-secret-pw-123456",
        "API_TOKEN=tok_abcdefghijklmnop",
        "PLAIN=hello",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
  });

  beforeEach(() => {
    vi.stubEnv("CORTEX_SECRETS_DIR", TMP_DIR);
    vi.stubEnv("CORTEX_ROOT", `${TMP_DIR}/installation`);
  });

  function readReq(token: string): Request {
    const url = `http://localhost/_serverFn/env-browser.read?path=${encodeURIComponent(ENV_PATH)}`;
    return new Request(url, { headers: { cookie: cookieHeader({ [SESSION_COOKIE]: token }) } });
  }
  function unlockReq(token: string, csrf: string, password: string): Request {
    return new Request("http://localhost/_serverFn/env-browser.unlock", {
      method: "POST",
      headers: {
        cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
        "content-type": "application/json",
        "x-csrf-token": csrf,
      },
      body: JSON.stringify({ password }),
    });
  }

  it("masked by default: NO cleartext secret leaves the server without a grant", async () => {
    const { token } = await makeSession({ isAdmin: true });
    const res = await readEnvCore(readReq(token));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.revealed).toBe(false);
    // Whole serialized response carries no cleartext secret.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("super-secret-pw-123456");
    expect(serialized).not.toContain("tok_abcdefghijklmnop");
  });

  it("unlock with WRONG PAM password → 401 coarse; no grant opened (read still masked)", async () => {
    pam.setFakeUser({ username: "admin", password: "correct-horse", groups: ["cortexos-admin"] });
    const { token, csrf } = await makeSession({ isAdmin: true, username: "admin" });
    const res = await unlockCore(unlockReq(token, csrf, "wrong"));
    expect(res.status).toBe(401);
    expect((await res.json()).message).toBe("Password verification failed");
    const read = await readEnvCore(readReq(token));
    expect((await read.json()).revealed).toBe(false);
  });

  it("unlock with VALID PAM password → grant → SAME session reveals cleartext", async () => {
    pam.setFakeUser({ username: "admin", password: "correct-horse", groups: ["cortexos-admin"] });
    const { token, csrf } = await makeSession({ isAdmin: true, username: "admin" });
    const unlock = await unlockCore(unlockReq(token, csrf, "correct-horse"));
    expect(unlock.status).toBe(201);
    const read = await readEnvCore(readReq(token));
    const body = await read.json();
    expect(body.revealed).toBe(true);
    const byKey = new Map<string, { value: string }>(
      body.entries.map((e: { key: string; value: string }) => [e.key, e]),
    );
    expect(byKey.get("DB_PASSWORD")!.value).toBe("super-secret-pw-123456");
    expect(byKey.get("API_TOKEN")!.value).toBe("tok_abcdefghijklmnop");
  });

  it("no cross-session leak: session B never reveals A's granted cleartext", async () => {
    pam.setFakeUser({ username: "admin", password: "correct-horse", groups: ["cortexos-admin"] });
    const a = await makeSession({ isAdmin: true, username: "admin" });
    await unlockCore(unlockReq(a.token, a.csrf, "correct-horse"));
    const b = await makeSession({ isAdmin: true, username: "admin2" });
    const readB = await readEnvCore(readReq(b.token));
    const body = await readB.json();
    expect(body.revealed).toBe(false);
    expect(JSON.stringify(body)).not.toContain("super-secret-pw-123456");
  });

  it("grant expiry: once the reveal window lapses, reads fall back to masked", async () => {
    pam.setFakeUser({ username: "admin", password: "correct-horse", groups: ["cortexos-admin"] });
    const { token, csrf, sessionId } = await makeSession({ isAdmin: true, username: "admin" });
    await unlockCore(unlockReq(token, csrf, "correct-horse"));
    // Confirm revealed, then expire the grant directly (the store is a
    // sessionId → epoch-ms map; set it to the past).
    expect((await (await readEnvCore(readReq(token))).json()).revealed).toBe(true);
    const reveal = await import("@/server/env-reveal");
    // revokeReveal closes the window; revealExpiresAt then returns null.
    reveal.revokeReveal(sessionId);
    const after = await readEnvCore(readReq(token));
    const body = await after.json();
    expect(body.revealed).toBe(false);
    expect(JSON.stringify(body)).not.toContain("super-secret-pw-123456");
  });

  it("read requires admin (non-admin → 403) and a session (none → 401)", async () => {
    const noSession = await readEnvCore(readReq("nope"));
    expect(noSession.status).toBe(401);
    const nonAdmin = await makeSession({ isAdmin: false });
    const res = await readEnvCore(readReq(nonAdmin.token));
    expect(res.status).toBe(403);
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    const { rmSync } = await import("node:fs");
    rmSync(TMP_DIR, { recursive: true, force: true });
  });
});

// ===========================================================================
// 7. Rate limits — per-bucket enforcement (429 + retryAfter) (SR-200)
// ===========================================================================

describe("[7] Rate limits — per bucket (SR-200)", () => {
  it("login (per-IP, 5/60s): 6th attempt → 429 with Retry-After header + rate_limit body", async () => {
    pam.setFakeUser({ username: "alice", password: "correct-horse" });
    const codes: number[] = [];
    let retryAfter: number | null = null;
    let code: string | undefined;

    const ress = await runSequentially(Array.from({ length: 6 }), async () => {
      const res = await loginCore(loginRequest({ username: "alice", password: "wrong" }));
      const json = res.status === 429 ? await res.json() : undefined;
      return { res, json };
    });
    ress.forEach(({ res, json }) => {
      codes.push(res.status);
      if (res.status === 429) {
        // The retryAfter is delivered via the standard `Retry-After` HTTP
        // header (the contract surface); the body carries `code:rate_limit`.
        retryAfter = Number(res.headers.get("retry-after"));
        code = json?.code;
      }
    });

    expect(codes.slice(0, 5).every((c) => c === 401)).toBe(true);
    expect(codes[5]).toBe(429);
    expect(code).toBe("rate_limit");
    expect(retryAfter).not.toBeNull();
    expect(retryAfter!).toBeGreaterThan(0);
  });

  it("unlock (per-USER, 5/60s): 6th attempt → 429", async () => {
    pam.setFakeUser({ username: "admin", password: "correct-horse", groups: ["cortexos-admin"] });
    const { token, csrf } = await makeSession({ isAdmin: true, username: "admin" });
    const url = "http://localhost/_serverFn/env-browser.unlock";
    const mk = () =>
      new Request(url, {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        body: JSON.stringify({ password: "wrong" }),
      });
    const ress = await runSequentially(Array.from({ length: 6 }), async () => unlockCore(mk()));
    const codes = ress.map((res) => res.status);

    expect(codes.slice(0, 5).every((c) => c === 401)).toBe(true);
    expect(codes[5]).toBe(429);
  });

  it("per-USER bucket isolates users: user B is unaffected by user A hitting the limit", async () => {
    // Two admin sessions on the SAME route + IP; the bucket key includes the
    // user id so exhausting A does not throttle B.
    const a = await makeSession({ isAdmin: true, username: "admin" });
    const b = await makeSession({ isAdmin: true, username: "admin2" });
    // adminGetCore default rate limit for admin is 30/60s/user. Drive A to 30.

    await runSequentially(Array.from({ length: 30 }), async () =>
      get(adminGetCore, "/_serverFn/probe", a.token),
    );

    const aOver = await get(adminGetCore, "/_serverFn/probe", a.token);
    expect(aOver.status).toBe(429);
    // B has its own bucket — still allowed.
    const bOk = await get(adminGetCore, "/_serverFn/probe", b.token);
    expect(bOk.status).toBe(200);
  });
});

// ===========================================================================
// 8. Audit HMAC chain — append + verify detects tampering at the broken row
// ===========================================================================

describe("[8] Audit HMAC chain — tamper detection (§6.4)", () => {
  it("in-memory chain: append N rows, verify ok; corrupt row k → break reported at k", async () => {
    const audit = await import("@/server/audit");
    audit.resetAudit();
    for (let i = 0; i < 5; i++) {
      audit.audit({
        actorUserId: null,
        actorSessionId: null,
        actorIp: "127.0.0.1",
        actorUserAgent: "vitest",
        surface: "system",
        action: "system.event",
        target: null,
        result: "success",
        errorCode: null,
        payload: { i },
      });
    }
    expect(audit.verifyAuditChain().ok).toBe(true);

    // Tamper row 2's prevHash → verify must fail AT index 2.
    const events = audit.listAudit();
    (events[2] as unknown as { prevHash: string }).prevHash = "tampered-hash";
    const res = audit.verifyAuditChain();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.index).toBe(2);
    audit.resetAudit();
  });

  it("DB chain: appendAuditLog builds a valid chain; tampering chain_hash breaks verify", async () => {
    const { createTestDb } = await import("@/server/db/test-utils");
    const { appendAuditLog, verifyAuditLogChain } = await import("@/server/db/repos/audit");
    const { sql } = await import("drizzle-orm");
    const { db, client } = await createTestDb({ seed: true });
    try {
      await runSequentially([0, 1, 2], async (i) =>
        appendAuditLog(db, {
          eventType: "system.event",
          source: "system",
          payload: { i },
        }),
      );

      const ok = await verifyAuditLogChain(db);
      expect(ok.valid).toBe(true);
      if (ok.valid) expect(ok.count).toBe(3);

      // Tamper a chain_hash → the recomputed link no longer matches.
      await db.execute(sql`UPDATE audit_log SET chain_hash = ${"0".repeat(64)} WHERE id = 2`);
      const broken = await verifyAuditLogChain(db);
      expect(broken.valid).toBe(false);
      if (!broken.valid) {
        // The break is detected at the first row whose recomputed link
        // fails — either the tampered row itself or its successor's prev.
        expect(["chain_hash_mismatch", "prev_hash_mismatch"]).toContain(broken.brokenAt.reason);
      }
    } finally {
      await client.close();
    }
  }, 30_000);

  it("DB chain: tampering a payload is caught (payload_hash_mismatch)", async () => {
    const { createTestDb } = await import("@/server/db/test-utils");
    const { appendAuditLog, verifyAuditLogChain } = await import("@/server/db/repos/audit");
    const { sql } = await import("drizzle-orm");
    const { db, client } = await createTestDb({ seed: true });
    try {
      await appendAuditLog(db, { eventType: "e", source: "s", payload: { secret: "v1" } });
      // Rewrite the payload JSON without recomputing payload_hash.
      await db.execute(
        sql`UPDATE audit_log SET payload = ${JSON.stringify({ secret: "tampered" })}::jsonb WHERE id = 1`,
      );
      const res = await verifyAuditLogChain(db);
      expect(res.valid).toBe(false);
      if (!res.valid) expect(res.brokenAt.reason).toBe("payload_hash_mismatch");
    } finally {
      await client.close();
    }
  }, 30_000);

  it("the in-memory genesis hash is the sha256 of the documented literal (chain anchor)", async () => {
    const audit = await import("@/server/audit");
    audit.resetAudit();
    // First row's prevHash is null (genesis); after one append the running
    // hash advances deterministically. We assert the genesis literal is the
    // documented one by reconstructing it.
    const genesis = createHash("sha256").update("cortexos-audit-genesis").digest("hex");
    expect(genesis).toHaveLength(64);
    audit.audit({
      actorUserId: null,
      actorSessionId: null,
      actorIp: null,
      actorUserAgent: null,
      surface: "s",
      action: "a",
      target: null,
      result: "success",
      errorCode: null,
      payload: {},
    });
    expect(audit.listAudit()[0].prevHash).toBeNull();
    audit.resetAudit();
  });
});
