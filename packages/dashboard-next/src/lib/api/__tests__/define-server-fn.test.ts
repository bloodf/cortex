// @vitest-environment node
/**
 * WP-01 unit gate — the security pipeline `defineServerFn` runs.
 *
 * `defineServerFn` wraps `createServerFn` and, on the server, delegates 1-1 to
 * `runServerFnGate` → `defineApiRoute(opts)` (the `(Request) => Response`
 * pipeline in `@/server/server-fn-pipeline`). The pipeline IS the security
 * logic; it is a plain function exercisable in a Node test without the
 * createServerFn compiler transform. (The full RPC-runtime proof — driving the
 * extracted server fn over HTTP on the built node server — is captured in
 * `docs/rebuild/STATUS.md` WP-01, because the server-fn transform only runs in
 * the Vite/Nitro build, not under vitest: a bare `await fn()` in vitest never
 * invokes the extracted handler.)
 *
 * This asserts the exact gate matrix `defineServerFn` enforces per request:
 * authed→200, unauth→401, non-admin→403, admin→200, bad input→400, mutation
 * missing/stolen/mismatched CSRF→403, valid session-bound CSRF→200/201.
 *
 * In-memory session store (no DB; DB_PASSWORD unset under test).
 */

import { describe, it, expect, beforeEach } from "vitest";

import { z } from "zod";
import {
  InMemorySessionStore,
  setSessionStore,
  resetSessionStore,
  generateSessionToken,
} from "@/server/auth/session-store";
import { SESSION_COOKIE, CSRF_COOKIE } from "@/server/config";
import {
  defineApiRoute,
  resetRateLimitBuckets,
  type ApiRouteCore,
} from "@/server/server-fn-pipeline";
import { defineServerFn } from "../define-server-fn";

let store: InMemorySessionStore;

beforeEach(() => {
  resetSessionStore();
  store = new InMemorySessionStore();
  setSessionStore(store);
  resetRateLimitBuckets();
});

// The gated cores `defineServerFn` delegates to (same opts the probe fns use).
const pingInput = z.object({ n: z.coerce.number().int().optional() }).strict();

const anyCore: ApiRouteCore = defineApiRoute({
  methods: ["GET", "POST"],
  auth: "any",
  input: pingInput,
  surface: "system",
  action: "system.probe",
  handler: ({ user, input }) => ({
    ok: true,
    user: user ? user.username : null,
    n: input.n ?? null,
  }),
});

const adminCore: ApiRouteCore = defineApiRoute({
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

async function makeSession(opts: { isAdmin: boolean }): Promise<{ token: string; csrf: string }> {
  const csrf = generateSessionToken();
  const res = await store.createSession({
    username: opts.isAdmin ? "admin" : "alice",
    csrfToken: csrf,
    ip: "127.0.0.1",
    userAgent: "vitest",
    isAdmin: opts.isAdmin,
  });
  return { token: res.token, csrf };
}

function cookieHeader(parts: Record<string, string>): string {
  return Object.entries(parts)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("; ");
}

describe("defineServerFn — produces a gate middleware", () => {
  it("returns a TanStack function middleware with a server hook", () => {
    const gate = defineServerFn({
      method: "GET",
      auth: "any",
      surface: "system",
      action: "system.shape",
      handler: () => ({ ok: true }),
    });
    // createMiddleware().server(...) yields an object carrying its options.
    expect(gate).toBeTypeOf("object");
    expect(gate).toHaveProperty("options");
    expect(typeof (gate as unknown as { options: { server?: unknown } }).options.server).toBe(
      "function",
    );
  });
});

describe("gate — auth:any", () => {
  it("200 with a valid session", async () => {
    const { token } = await makeSession({ isAdmin: false });
    const res = await anyCore(
      new Request("http://localhost/_serverFn/probe", {
        headers: { cookie: cookieHeader({ [SESSION_COOKIE]: token }) },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, user: "alice" });
  });

  it("401 without a session", async () => {
    const res = await anyCore(new Request("http://localhost/_serverFn/probe"));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("auth");
  });

  it("applies framework security headers on success", async () => {
    const { token } = await makeSession({ isAdmin: false });
    const res = await anyCore(
      new Request("http://localhost/_serverFn/probe", {
        headers: { cookie: cookieHeader({ [SESSION_COOKIE]: token }) },
      }),
    );
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("gate — auth:admin", () => {
  it("403 for an authenticated non-admin", async () => {
    const { token } = await makeSession({ isAdmin: false });
    const res = await adminCore(
      new Request("http://localhost/_serverFn/probe", {
        headers: { cookie: cookieHeader({ [SESSION_COOKIE]: token }) },
      }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("permission");
  });

  it("200 for an admin", async () => {
    const { token } = await makeSession({ isAdmin: true });
    const res = await adminCore(
      new Request("http://localhost/_serverFn/probe", {
        headers: { cookie: cookieHeader({ [SESSION_COOKIE]: token }) },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, admin: "admin" });
  });

  it("401 for an admin route without a session", async () => {
    const res = await adminCore(new Request("http://localhost/_serverFn/probe"));
    expect(res.status).toBe(401);
  });
});

describe("gate — input validation", () => {
  it("400 with validation details on bad input", async () => {
    const { token } = await makeSession({ isAdmin: false });
    const res = await anyCore(
      new Request("http://localhost/_serverFn/probe?n=not-a-number", {
        headers: { cookie: cookieHeader({ [SESSION_COOKIE]: token }) },
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("validation");
    expect(Array.isArray(body.details)).toBe(true);
    expect(body.details.length).toBeGreaterThan(0);
  });
});

describe("gate — mutation CSRF (double-submit + session-bound)", () => {
  it("403 on POST without a CSRF header", async () => {
    const { token, csrf } = await makeSession({ isAdmin: false });
    const res = await mutateCore(
      new Request("http://localhost/_serverFn/probe", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("permission");
  });

  it("403 on a CSRF cookie WITHOUT the matching header (stolen-cookie attack)", async () => {
    const { token, csrf } = await makeSession({ isAdmin: false });
    const res = await mutateCore(
      new Request("http://localhost/_serverFn/probe", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("403 on a mismatched CSRF header (not session-bound)", async () => {
    const { token, csrf } = await makeSession({ isAdmin: false });
    const res = await mutateCore(
      new Request("http://localhost/_serverFn/probe", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
          "x-csrf-token": generateSessionToken(),
        },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("201 with a valid session-bound CSRF token (cookie === header === session)", async () => {
    const { token, csrf } = await makeSession({ isAdmin: false });
    const res = await mutateCore(
      new Request("http://localhost/_serverFn/probe", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        body: JSON.stringify({ note: "hi" }),
      }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ ok: true, user: "alice" });
  });

  it("401 on POST with no session (CSRF surfaces as auth)", async () => {
    const res = await mutateCore(
      new Request("http://localhost/_serverFn/probe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(401);
  });
});
