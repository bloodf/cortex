// @vitest-environment node
/**
 * WP-11 gate tests — docker server fn security gates.
 *
 * Exercises the gate via the underlying `defineApiRoute` core
 * (the `(Request) => Response` pipeline) — the createServerFn compiler
 * transform only runs in the Vite/Nitro build, so a bare `await
 * listContainers()` under vitest never invokes the extracted handler.
 *
 * Also includes a node-env gate for CORTEX_DOCKER_REAL: verifies that
 * real-data falls back to stub data when the env flag is 0.
 *
 * Patterns copied from services.functions.test.ts (WP-10 reference).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
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

// ---------------------------------------------------------------------------
// Gate cores — mirror the docker.functions.ts gates without the DB
// ---------------------------------------------------------------------------

// listContainers gate: auth 'any'
const listContainersCore: ApiRouteCore = defineApiRoute({
  methods: ["GET"],
  auth: "any",
  input: z
    .object({
      filter: z.enum(["all", "running", "stopped", "paused", "restarting"]).optional(),
      query: z.string().max(128).optional(),
    })
    .strict(),
  surface: "docker",
  action: "docker.containers.list",
  handler: () => ({ items: [] }),
});

// dockerAction gate: auth 'admin', POST mutation
const dockerActionCore: ApiRouteCore = defineApiRoute({
  methods: ["POST"],
  auth: "admin",
  input: z
    .object({
      op: z.string().min(1).max(64),
      args: z.record(z.string(), z.unknown()).default({}),
      approvalToken: z.string().optional(),
    })
    .strict(),
  rateLimit: { limit: 10, windowSec: 60, bucket: "user" },
  surface: "docker",
  action: "docker.action",
  handler: () => ({ result: { op: "docker.logs", argv: [], output: "", durationMs: 0 } }),
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
// listContainers gate (auth: any)
// ---------------------------------------------------------------------------

describe("docker.containers.list gate (auth: any)", () => {
  it("200 with a valid session", async () => {
    const { token } = await makeSession({ isAdmin: false });
    const res = await listContainersCore(
      new Request("http://localhost/_serverFn/docker.containers.list", {
        headers: { cookie: cookieHeader({ [SESSION_COOKIE]: token }) },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ items: [] });
  });

  it("401 without a session", async () => {
    const res = await listContainersCore(
      new Request("http://localhost/_serverFn/docker.containers.list"),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("auth");
  });
});

// ---------------------------------------------------------------------------
// dockerAction gate (auth: admin, POST mutation)
// ---------------------------------------------------------------------------

describe("docker.action gate (auth: admin, mutation)", () => {
  it("403 for an authenticated non-admin (even with valid CSRF)", async () => {
    const { token, csrf } = await makeSession({ isAdmin: false });
    const res = await dockerActionCore(
      new Request("http://localhost/_serverFn/docker.action", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        body: JSON.stringify({ op: "docker.logs", args: { container: "grafana-1" } }),
      }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("permission");
  });

  it("403 for an admin without a CSRF header (stolen-cookie attack)", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const res = await dockerActionCore(
      new Request("http://localhost/_serverFn/docker.action", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
          // no x-csrf-token header
        },
        body: JSON.stringify({ op: "docker.logs", args: { container: "grafana-1" } }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("201 for an admin with a valid session-bound CSRF token", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const res = await dockerActionCore(
      new Request("http://localhost/_serverFn/docker.action", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        body: JSON.stringify({ op: "docker.logs", args: { container: "grafana-1" } }),
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ result: { op: "docker.logs" } });
  });
});

// ---------------------------------------------------------------------------
// Node-env gate: CORTEX_DOCKER_REAL=0 falls back to stub data
// ---------------------------------------------------------------------------

describe("CORTEX_DOCKER_REAL=0 → stub data (no real docker calls)", () => {
  const originalEnv = process.env.CORTEX_DOCKER_REAL;

  beforeEach(() => {
    process.env.CORTEX_DOCKER_REAL = "0";
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.CORTEX_DOCKER_REAL;
    } else {
      process.env.CORTEX_DOCKER_REAL = originalEnv;
    }
  });

  it("listContainers returns stub containers when CORTEX_DOCKER_REAL=0", async () => {
    // Import real-data directly (bypasses the createServerFn transform
    // which only runs in the Vite build). We assert the stub path.
    const { listContainers } = await import("@/server/docker/real-data");
    const items = await listContainers();
    // Stub seed has at least grafana-1
    expect(items.length).toBeGreaterThan(0);
    expect(items.some((c) => c.name === "grafana-1")).toBe(true);
  });

  it("listImages returns stub images (no <none> repos) when CORTEX_DOCKER_REAL=0", async () => {
    const { listImages } = await import("@/server/docker/real-data");
    const items = await listImages();
    expect(items.length).toBeGreaterThan(0);
    // Verify none have <none> repo or tag
    items.forEach((img) => {
      expect(img.repo).not.toBe("<none>");
      expect(img.tag).not.toBe("<none>");
    });
  });

  it("listVolumes returns stub volumes when CORTEX_DOCKER_REAL=0", async () => {
    const { listVolumes } = await import("@/server/docker/real-data");
    const items = await listVolumes();
    expect(items.length).toBeGreaterThan(0);
    expect(items.some((v) => v.name === "grafana-data")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// containerLogs gate (MP-009 — auth: admin, GET, id hex regex max 64,
// limit int 1..500). Mirrors the unitLogs shape in systemd.functions.test.ts
// but for the docker surface. Returns { lines: string[] }.
// ---------------------------------------------------------------------------

const containerLogsCore: ApiRouteCore = defineApiRoute({
  methods: ["GET"],
  auth: "admin",
  input: z
    .object({
      id: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[0-9a-fA-F]+$/, "container id must be hex"),
      limit: z.coerce.number().int().min(1).max(500).optional(),
    })
    .strict(),
  surface: "docker",
  action: "docker.container.logs",
  target: (i) => (i as { id: string }).id,
  handler: () => ({ lines: ["alpha", "beta"] }),
});

describe("docker.container.logs gate (auth: admin)", () => {
  it("200 with admin session and valid input", async () => {
    const { token } = await makeSession({ isAdmin: true });
    const res = await containerLogsCore(
      new Request("http://localhost/_serverFn/docker.container.logs?id=abc123&limit=10", {
        headers: { cookie: cookieHeader({ [SESSION_COOKIE]: token }) },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ lines: ["alpha", "beta"] });
  });

  it("401 without a session", async () => {
    const res = await containerLogsCore(
      new Request("http://localhost/_serverFn/docker.container.logs?id=abc123"),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("auth");
  });

  it("403 for an authenticated non-admin", async () => {
    const { token } = await makeSession({ isAdmin: false });
    const res = await containerLogsCore(
      new Request("http://localhost/_serverFn/docker.container.logs?id=abc123", {
        headers: { cookie: cookieHeader({ [SESSION_COOKIE]: token }) },
      }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("permission");
  });

  it("400 for an invalid id (non-hex characters)", async () => {
    const { token } = await makeSession({ isAdmin: true });
    const res = await containerLogsCore(
      new Request("http://localhost/_serverFn/docker.container.logs?id=zzz!", {
        headers: { cookie: cookieHeader({ [SESSION_COOKIE]: token }) },
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("validation");
  });

  it("400 for limit out of range (0)", async () => {
    const { token } = await makeSession({ isAdmin: true });
    const res = await containerLogsCore(
      new Request("http://localhost/_serverFn/docker.container.logs?id=abc&limit=0", {
        headers: { cookie: cookieHeader({ [SESSION_COOKIE]: token }) },
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("validation");
  });

  it("400 for limit out of range (501)", async () => {
    const { token } = await makeSession({ isAdmin: true });
    const res = await containerLogsCore(
      new Request("http://localhost/_serverFn/docker.container.logs?id=abc&limit=501", {
        headers: { cookie: cookieHeader({ [SESSION_COOKIE]: token }) },
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("validation");
  });
});
