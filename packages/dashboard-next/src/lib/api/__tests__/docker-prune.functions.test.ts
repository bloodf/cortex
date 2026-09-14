// @vitest-environment node
/**
 * dockerPrune gate tests (plan 0.5).
 *
 * Drives the REAL dockerPrune handler (and the real prune bridge with an
 * injected fake executor) through the `defineApiRoute` pipeline. Asserts the
 * auth/CSRF/approval matrix:
 *   - 403 for an authenticated non-admin.
 *   - 412 for an admin with valid CSRF but NO approval token.
 *   - 201 happy path with a valid approval token; bridge issues the safe prune.
 *
 * Patterns copied from agents.functions.test.ts (plan 0.5 reference).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

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
let dockerPruneCore: ApiRouteCore;
let calls: string[][];

beforeEach(async () => {
  setServerHmacKeyFromString("docker-prune-test-deterministic-key-0123456789ab");
  resetApprovalStore();
  resetSessionStore();
  store = new InMemorySessionStore();
  setSessionStore(store);
  resetRateLimitBuckets();

  const prune = await import("@/server/docker/prune");
  calls = [];
  const reclaimedByVerb: Record<string, string> = {
    image: "Total reclaimed space: 1.5GB",
    builder: "Total reclaimed space: 500MB",
  };
  prune.setExecutorForTests(async (argv) => {
    calls.push([...argv]);
    return { stdout: reclaimedByVerb[argv[0]] ?? "", stderr: "", exitCode: 0 };
  });

  const { dockerPruneGateOptions } = await import("../docker.functions");
  dockerPruneCore = defineApiRoute({
    methods: [dockerPruneGateOptions.method],
    auth: dockerPruneGateOptions.auth,
    input: dockerPruneGateOptions.input,
    rateLimit: dockerPruneGateOptions.rateLimit,
    surface: dockerPruneGateOptions.surface,
    action: dockerPruneGateOptions.action,
    approval: dockerPruneGateOptions.approval,
    handler: dockerPruneGateOptions.handler,
  });
});

afterEach(async () => {
  const prune = await import("@/server/docker/prune");
  prune.setExecutorForTests(null);
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

describe("docker.prune gate (auth: admin, approval: true) + prune bridge", () => {
  it("403 for an authenticated non-admin (with valid CSRF)", async () => {
    const { token, csrf } = await makeSession({ isAdmin: false });
    const res = await dockerPruneCore(
      new Request("http://localhost/_serverFn/docker.prune", {
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
    expect(calls).toHaveLength(0);
  });

  it("412 for an admin with valid CSRF but NO approval token", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const res = await dockerPruneCore(
      new Request("http://localhost/_serverFn/docker.prune", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(412);
    expect((await res.json()).code).toBe("approval_required");
    expect(calls).toHaveLength(0);
  });

  it("201 for admin + CSRF + valid approval token → bridge runs the SAFE prune only", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const resolved = (await store.resolveByToken(token))!;
    const approval = mintApproval({
      // Pipeline hashes actionHashFor("docker.prune", {}).
      action: "docker.prune",
      payload: {},
      sessionId: resolved.session.id,
      userId: resolved.user.id,
    });

    const res = await dockerPruneCore(
      new Request("http://localhost/_serverFn/docker.prune", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
          "x-csrf-token": csrf,
          "x-cortex-approval-token": approval.token,
        },
        body: JSON.stringify({}),
      }),
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as { reclaimedBytes: number };
    expect(body.reclaimedBytes).toBe(Math.round(1.5 * 1000 ** 3) + Math.round(500 * 1000 ** 2));

    // ONLY dangling images + build cache; never volumes / `-a` / system prune.
    expect(calls).toEqual([
      ["image", "prune", "-f"],
      ["builder", "prune", "-f"],
    ]);
    const flat = calls.flat();
    expect(flat).not.toContain("-a");
    expect(flat).not.toContain("--all");
    expect(flat).not.toContain("--volumes");
    expect(flat).not.toContain("system");
  });
});
