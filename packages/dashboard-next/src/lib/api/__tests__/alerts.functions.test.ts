// @vitest-environment node
/**
 * WP-17 gate tests — the security gates the alerts server fns enforce.
 *
 * Like `services.functions.test.ts`, this exercises the gate via the underlying
 * `defineApiRoute` core (the `(Request) => Response` pipeline) — the
 * createServerFn compiler transform only runs in the Vite/Nitro build, so a
 * bare `await listAlerts()` under vitest never invokes the extracted handler.
 * Here we assert the auth/RBAC/CSRF matrix the alerts gates apply, using the
 * SAME options the server fns use, WITHOUT touching the DB (handlers that would
 * hit the DB are replaced with a no-op so the gate, not the repo, is asserted —
 * DB_PASSWORD is unset under test).
 *
 * Node-env gate: all tests in this file only run outside a browser context.
 * The `// @vitest-environment node` pragma above ensures that.
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

// ---------------------------------------------------------------------------
// Node-env gate — belt-and-suspenders guard (the pragma above is sufficient,
// but this makes the intent explicit and catches misconfiguration).
// ---------------------------------------------------------------------------
if (typeof window !== "undefined") {
  throw new Error(
    "alerts.functions.test.ts must run in node environment (// @vitest-environment node)",
  );
}

let store: InMemorySessionStore;

beforeEach(() => {
  resetSessionStore();
  store = new InMemorySessionStore();
  setSessionStore(store);
  resetRateLimitBuckets();
});

// ---------------------------------------------------------------------------
// Gate instances (mirror the real server fn options; handler is a no-op)
// ---------------------------------------------------------------------------

// listAlerts gate: auth 'any'
const listCore: ApiRouteCore = defineApiRoute({
  methods: ["GET"],
  auth: "any",
  input: z
    .object({ serviceId: z.number().optional(), enabledOnly: z.boolean().optional() })
    .strict(),
  surface: "alerts",
  action: "alerts.list",
  handler: () => ({ rules: [] }),
});

// createAlert gate: auth 'admin', mutation
const createCore: ApiRouteCore = defineApiRoute({
  methods: ["POST"],
  auth: "admin",
  input: z.object({
    serviceId: z.number().int().positive(),
    name: z.string().min(1).max(255),
    condition: z.enum(["offline", "online", "response_time"]),
    thresholdMs: z.number().nullable().optional(),
    enabled: z.boolean().default(true),
  }),
  surface: "alerts",
  action: "alerts.create",
  target: (i) => (i as { name: string }).name,
  handler: () => ({ rule: { id: 1, name: "test-rule" } }),
});

// getAlert gate: auth 'any'
const getCore: ApiRouteCore = defineApiRoute({
  methods: ["GET"],
  auth: "any",
  input: z.object({ id: z.coerce.number().int().positive() }).strict(),
  surface: "alerts",
  action: "alerts.read",
  target: (i) => String(i.id),
  handler: () => ({ rule: { id: 1 } }),
});

// patchAlert gate: auth 'admin', mutation
const patchCore: ApiRouteCore = defineApiRoute({
  methods: ["POST"],
  auth: "admin",
  input: z.object({
    id: z.number().int().positive(),
    enabled: z.boolean().optional(),
  }),
  surface: "alerts",
  action: "alerts.update",
  target: (i) => String((i as { id: number }).id),
  handler: () => ({ rule: { id: 1, enabled: false } }),
});

// deleteAlert gate: auth 'admin', mutation
const deleteCore: ApiRouteCore = defineApiRoute({
  methods: ["POST"],
  auth: "admin",
  input: z.object({ id: z.number().int().positive() }).strict(),
  surface: "alerts",
  action: "alerts.delete",
  target: (i) => String(i.id),
  handler: () => ({ ok: true }),
});

// alertHistory gate: auth 'any'
const historyCore: ApiRouteCore = defineApiRoute({
  methods: ["GET"],
  auth: "any",
  input: z
    .object({
      ruleId: z.number().optional(),
      serviceId: z.number().optional(),
      limit: z.number().optional(),
    })
    .strict(),
  surface: "alerts",
  action: "alerts.history",
  handler: () => ({ history: [] }),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// listAlerts gate (auth: any)
// ---------------------------------------------------------------------------

describe("alerts.list gate (auth: any)", () => {
  it("200 with a valid session", async () => {
    const { token } = await makeSession({ isAdmin: false });
    const res = await listCore(
      new Request("http://localhost/_serverFn/alerts.list", {
        headers: { cookie: cookieHeader({ [SESSION_COOKIE]: token }) },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ rules: [] });
  });

  it("401 without a session", async () => {
    const res = await listCore(new Request("http://localhost/_serverFn/alerts.list"));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("auth");
  });
});

// ---------------------------------------------------------------------------
// createAlert gate (auth: admin, mutation)
// ---------------------------------------------------------------------------

describe("alerts.create gate (auth: admin, mutation)", () => {
  it("403 for an authenticated non-admin (even with valid CSRF)", async () => {
    const { token, csrf } = await makeSession({ isAdmin: false });
    const res = await createCore(
      new Request("http://localhost/_serverFn/alerts.create", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        body: JSON.stringify({
          serviceId: 1,
          name: "test-rule",
          condition: "offline",
          enabled: true,
        }),
      }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("permission");
  });

  it("403 for an admin without a CSRF header (stolen-cookie attack)", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const res = await createCore(
      new Request("http://localhost/_serverFn/alerts.create", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
          // missing x-csrf-token
        },
        body: JSON.stringify({
          serviceId: 1,
          name: "test-rule",
          condition: "offline",
          enabled: true,
        }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("201 for an admin with a valid session-bound CSRF token", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const res = await createCore(
      new Request("http://localhost/_serverFn/alerts.create", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        body: JSON.stringify({
          serviceId: 1,
          name: "test-rule",
          condition: "offline",
          enabled: true,
        }),
      }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ rule: { id: 1 } });
  });
});

// ---------------------------------------------------------------------------
// getAlert gate (auth: any)
// ---------------------------------------------------------------------------

describe("alerts.read gate (auth: any)", () => {
  it("200 with a valid session", async () => {
    const { token } = await makeSession({ isAdmin: false });
    const res = await getCore(
      new Request("http://localhost/_serverFn/alerts.read?id=1", {
        headers: { cookie: cookieHeader({ [SESSION_COOKIE]: token }) },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ rule: { id: 1 } });
  });

  it("401 without a session", async () => {
    const res = await getCore(new Request("http://localhost/_serverFn/alerts.read?id=1"));
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// patchAlert gate (auth: admin, mutation)
// ---------------------------------------------------------------------------

describe("alerts.update gate (auth: admin, mutation)", () => {
  it("403 for a non-admin caller", async () => {
    const { token, csrf } = await makeSession({ isAdmin: false });
    const res = await patchCore(
      new Request("http://localhost/_serverFn/alerts.update", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        body: JSON.stringify({ id: 1, enabled: false }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("201 for an admin with valid CSRF", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const res = await patchCore(
      new Request("http://localhost/_serverFn/alerts.update", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        body: JSON.stringify({ id: 1, enabled: false }),
      }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ rule: { enabled: false } });
  });
});

// ---------------------------------------------------------------------------
// deleteAlert gate (auth: admin, mutation)
// ---------------------------------------------------------------------------

describe("alerts.delete gate (auth: admin, mutation)", () => {
  it("403 for a non-admin caller", async () => {
    const { token, csrf } = await makeSession({ isAdmin: false });
    const res = await deleteCore(
      new Request("http://localhost/_serverFn/alerts.delete", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        body: JSON.stringify({ id: 1 }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("201 for an admin with valid CSRF", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const res = await deleteCore(
      new Request("http://localhost/_serverFn/alerts.delete", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        body: JSON.stringify({ id: 1 }),
      }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// alertHistory gate (auth: any)
// ---------------------------------------------------------------------------

describe("alerts.history gate (auth: any)", () => {
  it("200 with a valid session", async () => {
    const { token } = await makeSession({ isAdmin: false });
    const res = await historyCore(
      new Request("http://localhost/_serverFn/alerts.history", {
        headers: { cookie: cookieHeader({ [SESSION_COOKIE]: token }) },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ history: [] });
  });

  it("401 without a session", async () => {
    const res = await historyCore(new Request("http://localhost/_serverFn/alerts.history"));
    expect(res.status).toBe(401);
  });
});
