// @vitest-environment node
/**
 * WP-20 auth gate + handler tests. SECURITY-SENSITIVE.
 *
 * Like the WP-10 / WP-01 gate tests, this exercises the REAL gate + handler via
 * the underlying `defineApiRoute` core (the `(Request) => Response` pipeline) —
 * the createServerFn compiler transform only runs in the Vite/Nitro build, so a
 * bare `await login()` under vitest never invokes the extracted handler. We
 * build the core from the SAME options object the server fn uses
 * (`loginGateOptions` / `logoutGateOptions` / `meGateOptions`), so the auth
 * flow under test is exactly what ships.
 *
 * No DB: `DB_PASSWORD` is unset, so the session store is the in-memory backend
 * and PAM is the FakePamAuthenticator (pinned per-test). The handlers run real
 * PAM verify → group derive → session create → cookie set / clear logic.
 */

import { describe, it, expect, beforeEach } from "vitest";

import {
  InMemorySessionStore,
  setSessionStore,
  resetSessionStore,
} from "@/server/auth/session-store";
import {
  FakePamAuthenticator,
  setPamAuthenticator,
  resetPamAuthenticator,
} from "@/server/auth/pam";
import { SESSION_COOKIE, CSRF_COOKIE } from "@/server/config";
import {
  defineApiRoute,
  resetRateLimitBuckets,
  type ApiRouteCore,
} from "@/server/server-fn-pipeline";
import { listAudit, resetAudit } from "@/server/audit";

import { loginGateOptions, logoutGateOptions, meGateOptions } from "../auth.functions";

let store: InMemorySessionStore;
let pam: FakePamAuthenticator;

const loginCore: ApiRouteCore = defineApiRoute({
  methods: [loginGateOptions.method],
  ...loginGateOptions,
});
const logoutCore: ApiRouteCore = defineApiRoute({
  methods: [logoutGateOptions.method],
  ...logoutGateOptions,
});
const meCore: ApiRouteCore = defineApiRoute({ methods: [meGateOptions.method], ...meGateOptions });

beforeEach(() => {
  resetSessionStore();
  store = new InMemorySessionStore();
  setSessionStore(store);
  resetPamAuthenticator();
  pam = new FakePamAuthenticator();
  setPamAuthenticator(pam);
  resetRateLimitBuckets();
  resetAudit();
});

function cookieHeader(parts: Record<string, string>): string {
  return Object.entries(parts)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("; ");
}

/** Parse `Set-Cookie` header values into name → attributes. */
function parseSetCookies(res: Response): Map<string, { value: string; attrs: Set<string> }> {
  const out = new Map<string, { value: string; attrs: Set<string> }>();
  // Headers.getSetCookie is available in undici/Node 20+.
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

function loginRequest(body: unknown): Request {
  return new Request("http://localhost/_serverFn/auth.login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("auth.login (auth: public)", () => {
  it("bad credentials → coarse auth error (no user-enumeration), no session, audited denied", async () => {
    pam.setFakeUser({
      username: "alice",
      password: "correct-horse",
      groups: ["cortexos-admin", "cortexos-users"],
    });
    const res = await loginCore(loginRequest({ username: "alice", password: "wrong" }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("auth");
    // Coarse message — must NOT distinguish unknown-user from bad-password.
    expect(body.message).toBe("Invalid credentials");
    // No session was created, no cookies set.
    expect(parseSetCookies(res).has(SESSION_COOKIE)).toBe(false);
    // Audited as a denied login.
    const auditEvents = listAudit();
    const ev = auditEvents[auditEvents.length - 1];
    expect(ev.action).toBe("auth.login");
    expect(ev.result).toBe("denied");
  });

  it("unknown user → same coarse auth error as bad password (no enumeration)", async () => {
    pam.setFakeUser({ username: "alice", password: "correct-horse" });
    const res = await loginCore(loginRequest({ username: "nobody_x", password: "whatever" }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("auth");
    expect(body.message).toBe("Invalid credentials");
  });

  it("good credentials → session + both cookies; returns { user, session }", async () => {
    pam.setFakeUser({
      username: "alice",
      password: "correct-horse",
      groups: ["cortexos-admin", "cortexos-users"],
    });
    const res = await loginCore(loginRequest({ username: "alice", password: "correct-horse" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.user.username).toBe("alice");
    expect(body.user.isAdmin).toBe(true);
    expect(body.session.id).toBeTruthy();
    expect(body.session.csrfToken).toBeTruthy();

    const cookies = parseSetCookies(res);
    const session = cookies.get(SESSION_COOKIE);
    const csrf = cookies.get(CSRF_COOKIE);
    expect(session).toBeDefined();
    expect(csrf).toBeDefined();
    // Session cookie is HttpOnly; CSRF cookie is JS-readable (double-submit).
    expect(session!.attrs.has("httponly")).toBe(true);
    expect(csrf!.attrs.has("httponly")).toBe(false);
    // The set cookies resolve to a live session in the store.
    const resolved = await store.resolveByToken(session!.value);
    expect(resolved).not.toBeNull();
    expect(resolved!.user.username).toBe("alice");
    // CSRF cookie mirrors the session-bound token.
    expect(csrf!.value).toBe(resolved!.session.csrfToken);
  });

  it("valid non-admin user → session with cortexos-users (not admin)", async () => {
    pam.setFakeUser({ username: "bob", password: "pw", groups: ["cortexos-users"] });
    const res = await loginCore(loginRequest({ username: "bob", password: "pw" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.user.isAdmin).toBe(false);
  });
});

describe("auth.me (auth: public)", () => {
  async function makeSession(): Promise<{ token: string }> {
    const created = await store.createSession({
      username: "alice",
      csrfToken: "csrf-token-abc",
      ip: "127.0.0.1",
      userAgent: "vitest",
      isAdmin: true,
    });
    return { token: created.token };
  }

  it("with a valid session → { user, session }", async () => {
    const { token } = await makeSession();
    const res = await meCore(
      new Request("http://localhost/_serverFn/auth.me", {
        headers: { cookie: cookieHeader({ [SESSION_COOKIE]: token }) },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.username).toBe("alice");
    expect(body.session.id).toBeTruthy();
  });

  it("without a session → { user: null, session: null } (200, not 401)", async () => {
    const res = await meCore(new Request("http://localhost/_serverFn/auth.me"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user).toBeNull();
    expect(body.session).toBeNull();
  });
});

describe("auth.logout (auth: any, mutation)", () => {
  async function makeSession(): Promise<{ token: string; csrf: string }> {
    const csrf = "csrf-token-logout-1";
    const created = await store.createSession({
      username: "alice",
      csrfToken: csrf,
      ip: "127.0.0.1",
      userAgent: "vitest",
      isAdmin: true,
    });
    return { token: created.token, csrf };
  }

  it("with valid session + CSRF → invalidates the session and clears cookies", async () => {
    const { token, csrf } = await makeSession();
    const res = await logoutCore(
      new Request("http://localhost/_serverFn/auth.logout", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ ok: true });
    // Session row is gone.
    expect(await store.resolveByToken(token)).toBeNull();
    // Both cookies cleared (Max-Age=0).
    const cookies = parseSetCookies(res);
    expect(cookies.get(SESSION_COOKIE)?.attrs.has("max-age")).toBe(true);
    expect(cookies.get(SESSION_COOKIE)?.value).toBe("");
    expect(cookies.get(CSRF_COOKIE)?.value).toBe("");
  });

  it("POST without a CSRF header → 403 (stolen-cookie cannot log out)", async () => {
    const { token, csrf } = await makeSession();
    const res = await logoutCore(
      new Request("http://localhost/_serverFn/auth.logout", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(403);
    // Session still alive (logout did not run).
    expect(await store.resolveByToken(token)).not.toBeNull();
  });

  it("POST with no session → 401", async () => {
    const res = await logoutCore(
      new Request("http://localhost/_serverFn/auth.logout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(401);
  });
});
