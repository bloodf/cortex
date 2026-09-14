// @vitest-environment node
/**
 * WP-10 gate tests — the security gates the services server fns enforce.
 *
 * Like `define-server-fn.test.ts`, this exercises the gate via the underlying
 * `defineApiRoute` core (the `(Request) => Response` pipeline) — the
 * createServerFn compiler transform only runs in the Vite/Nitro build, so a
 * bare `await listServices()` under vitest never invokes the extracted handler.
 * Here we assert the auth/RBAC/CSRF matrix the services gates apply, using the
 * SAME options the server fns use, WITHOUT touching the DB (handlers that would
 * hit the DB are replaced with a no-op so the gate, not the repo, is asserted —
 * DB_PASSWORD is unset under test).
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

let store: InMemorySessionStore;

beforeEach(() => {
  resetSessionStore();
  store = new InMemorySessionStore();
  setSessionStore(store);
  resetRateLimitBuckets();
});

// list gate: auth 'any' (no DB call — handler returns a fixed shape).
const listCore: ApiRouteCore = defineApiRoute({
  methods: ["GET"],
  auth: "any",
  input: z.object({ category: z.string().optional() }).strict(),
  surface: "services",
  action: "services.list",
  handler: () => ({ rows: [], total: 0 }),
});

// create gate: auth 'admin' (no DB call).
const createCore: ApiRouteCore = defineApiRoute({
  methods: ["POST"],
  auth: "admin",
  input: z.object({ slug: z.string(), name: z.string(), category: z.string() }),
  surface: "services",
  action: "services.create",
  target: (i) => (i as { slug: string }).slug,
  handler: () => ({ ok: true }),
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

describe("services.list gate (auth: any)", () => {
  it("200 with a valid session", async () => {
    const { token } = await makeSession({ isAdmin: false });
    const res = await listCore(
      new Request("http://localhost/_serverFn/services.list", {
        headers: { cookie: cookieHeader({ [SESSION_COOKIE]: token }) },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ rows: [], total: 0 });
  });

  it("401 without a session", async () => {
    const res = await listCore(new Request("http://localhost/_serverFn/services.list"));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("auth");
  });
});

describe("services.create gate (auth: admin, mutation)", () => {
  it("403 for an authenticated non-admin (even with valid CSRF)", async () => {
    const { token, csrf } = await makeSession({ isAdmin: false });
    const res = await createCore(
      new Request("http://localhost/_serverFn/services.create", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        body: JSON.stringify({ slug: "x", name: "X", category: "AI" }),
      }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("permission");
  });

  it("403 for an admin without a CSRF header (stolen-cookie attack)", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const res = await createCore(
      new Request("http://localhost/_serverFn/services.create", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
        },
        body: JSON.stringify({ slug: "x", name: "X", category: "AI" }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("201 for an admin with a valid session-bound CSRF token", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const res = await createCore(
      new Request("http://localhost/_serverFn/services.create", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        body: JSON.stringify({ slug: "x", name: "X", category: "AI" }),
      }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ ok: true });
  });
});
