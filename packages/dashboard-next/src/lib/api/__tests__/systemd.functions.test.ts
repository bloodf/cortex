// @vitest-environment node
/**
 * WP-13 gate tests — the security gates the systemd server functions enforce.
 *
 * Like the WP-10 services tests, this exercises the gate via the underlying
 * `defineApiRoute` core (the `(Request) => Response` pipeline). Auth/RBAC/CSRF
 * matrix is asserted WITHOUT invoking the real systemd bridge (dynamic imports
 * inside handlers are replaced by the gate's no-op stubs). The bridge itself
 * is exercised in the server-level tests.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";

import {
  InMemorySessionStore,
  setSessionStore,
  resetSessionStore,
  generateSessionToken,
} from "@/server/auth/session-store";
import { SESSION_COOKIE, CSRF_COOKIE, setServerHmacKeyFromString } from "@/server/config";
import {
  defineApiRoute,
  resetRateLimitBuckets,
  type ApiRouteCore,
} from "@/server/server-fn-pipeline";
import { mintApproval, resetApprovalStore } from "@/server/approval";

let store: InMemorySessionStore;

beforeEach(() => {
  // Pin a deterministic HMAC key so minted approval tokens verify reproducibly.
  setServerHmacKeyFromString("wp13-systemd-test-deterministic-key-0123456789");
  resetApprovalStore();
  resetSessionStore();
  store = new InMemorySessionStore();
  setSessionStore(store);
  resetRateLimitBuckets();
});

// ---------------------------------------------------------------------------
// Gate cores (same shape defineServerFn would produce, without DB calls)
// ---------------------------------------------------------------------------

const listUnitsCore: ApiRouteCore = defineApiRoute({
  methods: ["GET"],
  auth: "any",
  input: z.object({}).strict(),
  surface: "systemd",
  action: "systemd.list",
  handler: () => ({ units: [] }),
});

const systemdActionCore: ApiRouteCore = defineApiRoute({
  methods: ["POST"],
  auth: "admin",
  input: z
    .object({
      action: z.enum(["start", "stop", "restart", "reload", "enable", "disable"]),
      name: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[A-Za-z0-9_.@-]+$/),
    })
    .strict(),
  rateLimit: { limit: 10, windowSec: 60, bucket: "user" },
  surface: "systemd",
  action: "systemd.action",
  target: (i) =>
    `${(i as { action: string; name: string }).action}:${(i as { action: string; name: string }).name}`,
  approval: true,
  handler: () => ({ status: "accepted", action: "start", name: "caddy.service" }),
});

const unitLogsCore: ApiRouteCore = defineApiRoute({
  methods: ["GET"],
  auth: "any",
  input: z
    .object({
      name: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[A-Za-z0-9_.@-]+$/),
      limit: z.coerce.number().int().min(1).max(500).optional(),
    })
    .strict(),
  surface: "systemd",
  action: "systemd.logs",
  target: (i) => (i as { name: string }).name,
  handler: () => ({ unit: "caddy.service", limit: 100, count: 0, lines: [] }),
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
// listUnits — auth: any
// ---------------------------------------------------------------------------

describe("systemd.list gate (auth: any)", () => {
  it("200 with a valid session", async () => {
    const { token } = await makeSession({ isAdmin: false });
    const res = await listUnitsCore(
      new Request("http://localhost/_serverFn/systemd.list", {
        headers: { cookie: cookieHeader({ [SESSION_COOKIE]: token }) },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ units: [] });
  });

  it("401 without a session", async () => {
    const res = await listUnitsCore(new Request("http://localhost/_serverFn/systemd.list"));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("auth");
  });
});

// ---------------------------------------------------------------------------
// systemdAction — auth: admin, approval required
// ---------------------------------------------------------------------------

describe("systemd.action gate (auth: admin, approval: true)", () => {
  it("401 without any session", async () => {
    const res = await systemdActionCore(
      new Request("http://localhost/_serverFn/systemd.action", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "start", name: "caddy.service" }),
      }),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("auth");
  });

  it("403 for an authenticated non-admin", async () => {
    const { token, csrf } = await makeSession({ isAdmin: false });
    const res = await systemdActionCore(
      new Request("http://localhost/_serverFn/systemd.action", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        body: JSON.stringify({ action: "start", name: "caddy.service" }),
      }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("permission");
  });

  it("403 for an admin missing CSRF header (stolen-cookie attack)", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const res = await systemdActionCore(
      new Request("http://localhost/_serverFn/systemd.action", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
          // no x-csrf-token
        },
        body: JSON.stringify({ action: "start", name: "caddy.service" }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("412 for an admin with valid CSRF but no approval token", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const res = await systemdActionCore(
      new Request("http://localhost/_serverFn/systemd.action", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
          "x-csrf-token": csrf,
          // no x-cortex-approval-token
        },
        body: JSON.stringify({ action: "start", name: "caddy.service" }),
      }),
    );
    // Pipeline returns 412 (Precondition Failed) when approval token is absent.
    expect(res.status).toBe(412);
    expect((await res.json()).code).toBe("approval_required");
  });

  it("400 for invalid unit name (shell metacharacter)", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const res = await systemdActionCore(
      new Request("http://localhost/_serverFn/systemd.action", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        body: JSON.stringify({ action: "start", name: "bad;unit" }),
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("validation");
  });

  it("400 for disallowed action verb", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const res = await systemdActionCore(
      new Request("http://localhost/_serverFn/systemd.action", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        body: JSON.stringify({ action: "kill", name: "caddy.service" }),
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("validation");
  });
  it("201 for admin + CSRF + valid approval token (minted with gate action)", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const resolved = (await store.resolveByToken(token))!;
    // Pipeline hashes actionHashFor("systemd.action", { action, name }).
    // Client must mint with the GATE's action string, NOT `systemd.<verb>`.
    const approval = mintApproval({
      action: "systemd.action",
      payload: { action: "start", name: "caddy.service" },
      sessionId: resolved.session.id,
      userId: resolved.user.id,
    });
    const res = await systemdActionCore(
      new Request("http://localhost/_serverFn/systemd.action", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
          "x-csrf-token": csrf,
          "x-cortex-approval-token": approval.token,
        },
        body: JSON.stringify({ action: "start", name: "caddy.service" }),
      }),
    );
    expect(res.status).toBe(201);
  });

  it("412 when token minted with per-verb action string (regression: action-hash mismatch)", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const resolved = (await store.resolveByToken(token))!;
    // Wrong: mint with `systemd.start`. Gate hashes `systemd.action` → mismatch.
    const approval = mintApproval({
      action: "systemd.start",
      payload: { action: "start", name: "caddy.service" },
      sessionId: resolved.session.id,
      userId: resolved.user.id,
    });
    const res = await systemdActionCore(
      new Request("http://localhost/_serverFn/systemd.action", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
          "x-csrf-token": csrf,
          "x-cortex-approval-token": approval.token,
        },
        body: JSON.stringify({ action: "start", name: "caddy.service" }),
      }),
    );
    expect(res.status).toBe(412);
    expect((await res.json()).code).toBe("approval_required");
  });
});

// ---------------------------------------------------------------------------
// unitLogs — auth: any
// ---------------------------------------------------------------------------

describe("systemd.logs gate (auth: any)", () => {
  it("200 with a valid session", async () => {
    const { token } = await makeSession({ isAdmin: false });
    const res = await unitLogsCore(
      new Request("http://localhost/_serverFn/systemd.logs?name=caddy.service", {
        headers: { cookie: cookieHeader({ [SESSION_COOKIE]: token }) },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ unit: "caddy.service", lines: [] });
  });

  it("401 without a session", async () => {
    const res = await unitLogsCore(
      new Request("http://localhost/_serverFn/systemd.logs?name=caddy.service"),
    );
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// hostLogs gate (MP-009 — auth: admin, GET, limit int 1..500).
// No `getUnit` precondition (this is the WHOLE host journal, not a unit).
// Returns { lines: string[] }.
// ---------------------------------------------------------------------------

const hostLogsCore: ApiRouteCore = defineApiRoute({
  methods: ["GET"],
  auth: "admin",
  input: z
    .object({
      limit: z.coerce.number().int().min(1).max(500).optional(),
    })
    .strict(),
  surface: "systemd",
  action: "systemd.host.logs",
  rateLimit: { limit: 10, windowSec: 60, bucket: "user" },
  handler: () => ({ limit: 100, count: 2, lines: ["ts1 hello", "ts2 world"] }),
});

describe("systemd.host.logs gate (auth: admin, no unit precondition)", () => {
  it("200 with admin session and default limit", async () => {
    const { token } = await makeSession({ isAdmin: true });
    const res = await hostLogsCore(
      new Request("http://localhost/_serverFn/systemd.host.logs", {
        headers: { cookie: cookieHeader({ [SESSION_COOKIE]: token }) },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ lines: ["ts1 hello", "ts2 world"] });
  });

  it("401 without a session", async () => {
    const res = await hostLogsCore(new Request("http://localhost/_serverFn/systemd.host.logs"));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("auth");
  });

  it("403 for an authenticated non-admin", async () => {
    const { token } = await makeSession({ isAdmin: false });
    const res = await hostLogsCore(
      new Request("http://localhost/_serverFn/systemd.host.logs", {
        headers: { cookie: cookieHeader({ [SESSION_COOKIE]: token }) },
      }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("permission");
  });

  it("400 for limit out of range (0)", async () => {
    const { token } = await makeSession({ isAdmin: true });
    const res = await hostLogsCore(
      new Request("http://localhost/_serverFn/systemd.host.logs?limit=0", {
        headers: { cookie: cookieHeader({ [SESSION_COOKIE]: token }) },
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("validation");
  });

  it("400 for limit out of range (501)", async () => {
    const { token } = await makeSession({ isAdmin: true });
    const res = await hostLogsCore(
      new Request("http://localhost/_serverFn/systemd.host.logs?limit=501", {
        headers: { cookie: cookieHeader({ [SESSION_COOKIE]: token }) },
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("validation");
  });
});
