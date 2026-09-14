// @vitest-environment node
/**
 * Contract tests — dependencies.functions gates (service graph + autostart).
 *
 * Same harness as systemd.functions.test.ts: each gate is exercised via its
 * `defineApiRoute` core (the `(Request) => Response` pipeline) with the same
 * gate options dependencies.functions.ts declares (methods/auth/input schema/
 * rateLimit/surface/action/approval). Auth/RBAC/CSRF/approval/rate-limit IS
 * what's under test — the handlers are no-op stubs returning static data, so
 * NO database, systemd, or docker call is ever made.
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
import { mintApproval, resetApprovalStore, isMintableAction } from "@/server/approval";
import { conflictError } from "@/server/errors/types";

let store: InMemorySessionStore;

beforeEach(() => {
  // Pin a deterministic HMAC key so minted approval tokens verify reproducibly.
  setServerHmacKeyFromString("wp-deps-gates-test-deterministic-key-0123456789");
  resetApprovalStore();
  resetSessionStore();
  store = new InMemorySessionStore();
  setSessionStore(store);
  resetRateLimitBuckets();
});

// ---------------------------------------------------------------------------
// Gate cores — mirror dependencies.functions.ts gate options exactly
// ---------------------------------------------------------------------------

const listDependenciesCore: ApiRouteCore = defineApiRoute({
  methods: ["GET"],
  auth: "any",
  input: z.object({}).strict(),
  rateLimit: { limit: 60, windowSec: 60, bucket: "user" },
  surface: "dependencies",
  action: "dependencies.list",
  handler: () => ({ nodes: [], edges: [] }),
});

const scanDependenciesNowCore: ApiRouteCore = defineApiRoute({
  methods: ["POST"],
  auth: "admin",
  input: z.object({}).strict(),
  rateLimit: { limit: 6, windowSec: 60, bucket: "user" },
  surface: "dependencies",
  action: "dependencies.scan",
  handler: () => ({ configured: 0, observed: 0, upserted: 0 }),
});

const edgeInput = z
  .object({
    sourceSlug: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9-]*$/),
    targetSlug: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9-]*$/),
    kind: z.enum(["configured", "observed"]).default("configured"),
  })
  .strict();

const setDependencyEdgeCore: ApiRouteCore = defineApiRoute({
  methods: ["POST"],
  auth: "admin",
  input: edgeInput,
  rateLimit: { limit: 30, windowSec: 60, bucket: "user" },
  surface: "dependencies",
  action: "dependencies.setEdge",
  handler: () => ({
    id: 1,
    sourceSlug: "hermes-main",
    targetSlug: "durindoor",
    kind: "configured",
    source: "manual",
    detail: null,
    lastSeenAt: null,
    createdAt: "2026-07-11T00:00:00.000Z",
  }),
});

const removeDependencyEdgeCore: ApiRouteCore = defineApiRoute({
  methods: ["POST"],
  auth: "admin",
  input: edgeInput,
  rateLimit: { limit: 30, windowSec: 60, bucket: "user" },
  surface: "dependencies",
  action: "dependencies.removeEdge",
  handler: () => ({ removed: true }),
});

interface AutostartStubInput {
  slug: string;
  enabled: boolean;
  force?: boolean;
}

const setServiceAutostartCore: ApiRouteCore = defineApiRoute({
  methods: ["POST"],
  auth: "admin",
  input: z
    .object({
      slug: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[a-z0-9][a-z0-9-]*$/),
      enabled: z.boolean(),
      force: z.boolean().optional(),
    })
    .strict(),
  rateLimit: { limit: 10, windowSec: 60, bucket: "user" },
  surface: "services",
  action: "services.autostart",
  target: (input) => (input).slug,
  approval: true,
  handler: ({ input }: { input: AutostartStubInput }) => {
    // Stand-in for the disable preflight: disabling a provider with active
    // autostarting dependents conflicts unless force bypasses it.
    if (input.enabled === false && !input.force) {
      throw conflictError("active autostarting dependents would be stranded", {
        blocked: true,
        dependents: ["hermes-main"],
      });
    }
    return { slug: input.slug, autostart: input.enabled, systemd: null, docker: null };
  },
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
// Approval allowlist
// ---------------------------------------------------------------------------

describe("approval allowlist", () => {
  it("'services.autostart' is mintable", () => {
    expect(isMintableAction("services.autostart")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// listDependencies — GET, auth: any
// ---------------------------------------------------------------------------

describe("dependencies.list gate (auth: any)", () => {
  it("200 with a valid non-admin session", async () => {
    const { token } = await makeSession({ isAdmin: false });
    const res = await listDependenciesCore(
      new Request("http://localhost/_serverFn/dependencies.list", {
        headers: { cookie: cookieHeader({ [SESSION_COOKIE]: token }) },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ nodes: [], edges: [] });
  });

  it("401 without a session", async () => {
    const res = await listDependenciesCore(
      new Request("http://localhost/_serverFn/dependencies.list"),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("auth");
  });
});

// ---------------------------------------------------------------------------
// scanDependenciesNow — POST, auth: admin, rate-limited, NO approval
// ---------------------------------------------------------------------------

describe("dependencies.scan gate (auth: admin, no approval)", () => {
  it("403 for an authenticated non-admin", async () => {
    const { token, csrf } = await makeSession({ isAdmin: false });
    const res = await scanDependenciesNowCore(
      new Request("http://localhost/_serverFn/dependencies.scan", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("permission");
  });

  it("201 for an admin with CSRF and no approval token", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const res = await scanDependenciesNowCore(
      new Request("http://localhost/_serverFn/dependencies.scan", {
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
    expect(await res.json()).toMatchObject({ configured: 0, observed: 0, upserted: 0 });
  });
});

// ---------------------------------------------------------------------------
// setDependencyEdge / removeDependencyEdge — POST, auth: admin
// ---------------------------------------------------------------------------

describe("dependencies.setEdge / removeEdge gates (auth: admin)", () => {
  const edgeBody = JSON.stringify({ sourceSlug: "hermes-main", targetSlug: "durindoor" });

  it("setEdge 403 for an authenticated non-admin", async () => {
    const { token, csrf } = await makeSession({ isAdmin: false });
    const res = await setDependencyEdgeCore(
      new Request("http://localhost/_serverFn/dependencies.setEdge", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        body: edgeBody,
      }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("permission");
  });

  it("setEdge 201 for an admin with CSRF", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const res = await setDependencyEdgeCore(
      new Request("http://localhost/_serverFn/dependencies.setEdge", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        body: edgeBody,
      }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      sourceSlug: "hermes-main",
      targetSlug: "durindoor",
      source: "manual",
    });
  });

  it("removeEdge 403 for an authenticated non-admin", async () => {
    const { token, csrf } = await makeSession({ isAdmin: false });
    const res = await removeDependencyEdgeCore(
      new Request("http://localhost/_serverFn/dependencies.removeEdge", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        body: edgeBody,
      }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("permission");
  });

  it("removeEdge 201 for an admin with CSRF", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const res = await removeDependencyEdgeCore(
      new Request("http://localhost/_serverFn/dependencies.removeEdge", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        body: edgeBody,
      }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ removed: true });
  });
});

// ---------------------------------------------------------------------------
// setServiceAutostart — POST, auth: admin, approval: true, 409 preflight
// ---------------------------------------------------------------------------

describe("services.autostart gate (auth: admin, approval: true)", () => {
  it("401 without any session", async () => {
    const res = await setServiceAutostartCore(
      new Request("http://localhost/_serverFn/services.autostart", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: "cortex-jellyfin", enabled: true }),
      }),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("auth");
  });

  it("403 for an authenticated non-admin", async () => {
    const { token, csrf } = await makeSession({ isAdmin: false });
    const res = await setServiceAutostartCore(
      new Request("http://localhost/_serverFn/services.autostart", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        body: JSON.stringify({ slug: "cortex-jellyfin", enabled: true }),
      }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("permission");
  });

  it("403 for an admin missing CSRF header (stolen-cookie attack)", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const res = await setServiceAutostartCore(
      new Request("http://localhost/_serverFn/services.autostart", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
          // no x-csrf-token
        },
        body: JSON.stringify({ slug: "cortex-jellyfin", enabled: true }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("412 for an admin with valid CSRF but a WRONG approval mint (action mismatch)", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const resolved = (await store.resolveByToken(token))!;
    // Wrong: mint with `systemd.action`. Gate hashes `services.autostart` → mismatch.
    const approval = mintApproval({
      action: "systemd.action",
      payload: { slug: "cortex-jellyfin", enabled: true },
      sessionId: resolved.session.id,
      userId: resolved.user.id,
    });
    const res = await setServiceAutostartCore(
      new Request("http://localhost/_serverFn/services.autostart", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
          "x-csrf-token": csrf,
          "x-cortex-approval-token": approval.token,
        },
        body: JSON.stringify({ slug: "cortex-jellyfin", enabled: true }),
      }),
    );
    expect(res.status).toBe(412);
    expect((await res.json()).code).toBe("approval_required");
  });

  it("201 for admin + CSRF + correct approval mint of 'services.autostart'", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const resolved = (await store.resolveByToken(token))!;
    const approval = mintApproval({
      action: "services.autostart",
      payload: { slug: "cortex-jellyfin", enabled: true },
      sessionId: resolved.session.id,
      userId: resolved.user.id,
    });
    const res = await setServiceAutostartCore(
      new Request("http://localhost/_serverFn/services.autostart", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
          "x-csrf-token": csrf,
          "x-cortex-approval-token": approval.token,
        },
        body: JSON.stringify({ slug: "cortex-jellyfin", enabled: true }),
      }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ slug: "cortex-jellyfin", autostart: true });
  });

  it("409 (conflict, blocked) when disabling with an active dependent and no force", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const resolved = (await store.resolveByToken(token))!;
    const approval = mintApproval({
      action: "services.autostart",
      payload: { slug: "durindoor", enabled: false },
      sessionId: resolved.session.id,
      userId: resolved.user.id,
    });
    const res = await setServiceAutostartCore(
      new Request("http://localhost/_serverFn/services.autostart", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
          "x-csrf-token": csrf,
          "x-cortex-approval-token": approval.token,
        },
        body: JSON.stringify({ slug: "durindoor", enabled: false }),
      }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code?: string; blocked?: boolean; dependents?: unknown };
    expect(body.code).toBe("conflict");
    expect(body.blocked).toBe(true);
    expect(Array.isArray(body.dependents) && body.dependents.length > 0).toBe(true);
  });

  it("201 when force: true bypasses the preflight (fresh mint covering force)", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const resolved = (await store.resolveByToken(token))!;
    const approval = mintApproval({
      action: "services.autostart",
      payload: { slug: "durindoor", enabled: false, force: true },
      sessionId: resolved.session.id,
      userId: resolved.user.id,
    });
    const res = await setServiceAutostartCore(
      new Request("http://localhost/_serverFn/services.autostart", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
          "x-csrf-token": csrf,
          "x-cortex-approval-token": approval.token,
        },
        body: JSON.stringify({ slug: "durindoor", enabled: false, force: true }),
      }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ slug: "durindoor", autostart: false });
  });
});
