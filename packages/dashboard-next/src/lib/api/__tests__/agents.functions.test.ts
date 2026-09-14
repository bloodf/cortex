// @vitest-environment node
/**
 * WP-21 gate tests — agents server fn security gates + node-env gate.
 *
 * Exercises the gate via the underlying `defineApiRoute` core (the
 * `(Request) => Response` pipeline) — the createServerFn compiler transform
 * only runs in the Vite/Nitro build, so a bare `await listAgents()` under
 * vitest never invokes the extracted handler.
 *
 * Also covers:
 * - HERMES_PROFILES_REGISTRY env gate: reading from a temp file vs default path
 * - Path traversal rejection in validateFilePath
 *
 * Patterns copied from docker.functions.test.ts (WP-11 reference).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
  setServerHmacKeyFromString("agents-functions-test-deterministic-key-0123456789");
  resetApprovalStore();
  resetSessionStore();
  store = new InMemorySessionStore();
  setSessionStore(store);
  resetRateLimitBuckets();
});

// ---------------------------------------------------------------------------
// Gate cores — mirror agents.functions.ts gates without real filesystem calls
// ---------------------------------------------------------------------------

// listAgents gate: auth 'any'
const listAgentsCore: ApiRouteCore = defineApiRoute({
  methods: ["GET"],
  auth: "any",
  input: z.object({}).strict(),
  surface: "agents",
  action: "agents.list",
  handler: () => ({ agents: [] }),
});

// uploadAgentFile gate: auth 'admin', POST mutation
const uploadAgentFileCore: ApiRouteCore = defineApiRoute({
  methods: ["POST"],
  auth: "admin",
  input: z
    .object({
      slug: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[a-z0-9_-]+$/),
      filename: z
        .string()
        .min(1)
        .max(255)
        .refine((f) => !f.includes("..") && !f.startsWith("/"), {
          message: "filename must not contain '..' or start with '/'",
        }),
      content: z.string().max(10 * 1024 * 1024),
    })
    .strict(),
  surface: "agents",
  action: "agents.file.upload",
  target: (i) => {
    const inp = i as { slug: string; filename: string };
    return `${inp.slug}:${inp.filename}`;
  },
  handler: () => ({ ok: true }),
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
// agents.list gate (auth: any)
// ---------------------------------------------------------------------------

describe("agents.list gate (auth: any)", () => {
  it("200 with a valid session", async () => {
    const { token } = await makeSession({ isAdmin: false });
    const res = await listAgentsCore(
      new Request("http://localhost/_serverFn/agents.list", {
        headers: { cookie: cookieHeader({ [SESSION_COOKIE]: token }) },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ agents: [] });
  });

  it("401 without a session", async () => {
    const res = await listAgentsCore(new Request("http://localhost/_serverFn/agents.list"));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("auth");
  });
});

// ---------------------------------------------------------------------------
// agents.file.upload gate (auth: admin, POST mutation)
// ---------------------------------------------------------------------------

describe("agents.file.upload gate (auth: admin, mutation)", () => {
  it("403 for an authenticated non-admin (even with valid CSRF)", async () => {
    const { token, csrf } = await makeSession({ isAdmin: false });
    const res = await uploadAgentFileCore(
      new Request("http://localhost/_serverFn/agents.file.upload", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        body: JSON.stringify({ slug: "default", filename: "test.txt", content: "hello" }),
      }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("permission");
  });

  it("403 for an admin without a CSRF header (stolen-cookie attack)", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const res = await uploadAgentFileCore(
      new Request("http://localhost/_serverFn/agents.file.upload", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
          // no x-csrf-token header
        },
        body: JSON.stringify({ slug: "default", filename: "test.txt", content: "hello" }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("201 for an admin with a valid session-bound CSRF token", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const res = await uploadAgentFileCore(
      new Request("http://localhost/_serverFn/agents.file.upload", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        body: JSON.stringify({ slug: "default", filename: "test.txt", content: "hello" }),
      }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it("400 for a filename with path traversal attempt (..)", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const res = await uploadAgentFileCore(
      new Request("http://localhost/_serverFn/agents.file.upload", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        body: JSON.stringify({
          slug: "default",
          filename: "../../etc/passwd",
          content: "evil",
        }),
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("validation");
  });

  it("400 for a filename starting with / (absolute path)", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const res = await uploadAgentFileCore(
      new Request("http://localhost/_serverFn/agents.file.upload", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        body: JSON.stringify({
          slug: "default",
          filename: "/etc/passwd",
          content: "evil",
        }),
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("validation");
  });
});

// ---------------------------------------------------------------------------
// Node-env gate: HERMES_PROFILES_REGISTRY reads from the env-specified path
// ---------------------------------------------------------------------------

describe("HERMES_PROFILES_REGISTRY env gate", () => {
  let tmpDir: string;
  let tmpRegistry: string;
  const originalEnv = process.env.HERMES_PROFILES_REGISTRY;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-agents-test-"));
    tmpRegistry = path.join(tmpDir, "profiles.json");
  });

  afterEach(() => {
    // restore env
    if (originalEnv === undefined) {
      delete process.env.HERMES_PROFILES_REGISTRY;
    } else {
      process.env.HERMES_PROFILES_REGISTRY = originalEnv;
    }
    // clean up tmp
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it("reads profiles from HERMES_PROFILES_REGISTRY when set", async () => {
    const profiles = {
      profiles: [{ profile: "test-agent", home: tmpDir, apiPort: 19999, model: "test/model" }],
    };
    fs.writeFileSync(tmpRegistry, JSON.stringify(profiles));
    process.env.HERMES_PROFILES_REGISTRY = tmpRegistry;

    // Re-import to pick up the new env (module is stateless — reads env each call)
    const { readRegistry } = await import("@/server/agents/registry");
    const result = readRegistry();
    expect(result).toHaveLength(1);
    expect(result[0].profile).toBe("test-agent");
    expect(result[0].model).toBe("test/model");
  });

  it("returns empty array when HERMES_PROFILES_REGISTRY points to missing file", async () => {
    process.env.HERMES_PROFILES_REGISTRY = path.join(tmpDir, "nonexistent.json");

    const { readRegistry } = await import("@/server/agents/registry");
    const result = readRegistry();
    expect(result).toEqual([]);
  });

  it("findProfileBySlug returns the matching profile", async () => {
    const profiles = {
      profiles: [
        { profile: "my-agent", home: tmpDir, apiPort: 18700, model: "cx/test" },
        { profile: "other-agent", home: tmpDir, apiPort: 18701, model: "cx/other" },
      ],
    };
    fs.writeFileSync(tmpRegistry, JSON.stringify(profiles));
    process.env.HERMES_PROFILES_REGISTRY = tmpRegistry;

    const { findProfileBySlug } = await import("@/server/agents/registry");
    const found = findProfileBySlug("my-agent");
    expect(found).not.toBeNull();
    expect(found?.profile).toBe("my-agent");

    const notFound = findProfileBySlug("does-not-exist");
    expect(notFound).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// validateFilePath — path traversal guard unit tests
// ---------------------------------------------------------------------------

describe("validateFilePath — path traversal guard", () => {
  it("accepts a simple filename", async () => {
    const { validateFilePath } = await import("@/server/agents/files");
    const target = validateFilePath("/some/dir", "config.yaml");
    expect(target).toBe("/some/dir/config.yaml");
  });

  it("throws path_traversal for '..' in filename", async () => {
    const { validateFilePath } = await import("@/server/agents/files");
    expect(() => validateFilePath("/some/dir", "../../etc/passwd")).toThrow("path_traversal");
  });

  it("throws path_traversal for absolute path filename", async () => {
    const { validateFilePath } = await import("@/server/agents/files");
    expect(() => validateFilePath("/some/dir", "/etc/passwd")).toThrow("path_traversal");
  });

  it("throws path_traversal for encoded traversal that resolves outside dir", async () => {
    const { validateFilePath } = await import("@/server/agents/files");
    // After resolve, ../.. from /some/dir would escape: verify post-resolve check
    expect(() => validateFilePath("/some/dir", "../sibling/evil")).toThrow("path_traversal");
  });
});

// ---------------------------------------------------------------------------
// agents.action gate + REAL control bridge (plan 0.5)
//
// Drives the REAL agentAction handler (and the real control bridge with an
// injected fake executor) through the `defineApiRoute` pipeline. Asserts the
// auth/CSRF/approval matrix AND that the bridge issued the expected systemctl
// argv. The slug allowlist is a temp Hermes registry.
// ---------------------------------------------------------------------------

describe("agents.action gate (auth: admin, approval: true) + control bridge", () => {
  let agentTmpDir: string;
  const originalRegistry = process.env.HERMES_PROFILES_REGISTRY;
  let agentActionCore: ApiRouteCore;
  let calls: string[][];

  beforeEach(async () => {
    agentTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-agent-action-"));
    const registry = path.join(agentTmpDir, "profiles.json");
    fs.writeFileSync(
      registry,
      JSON.stringify({
        profiles: [{ profile: "sample-agent", home: agentTmpDir, apiPort: 18700, model: "cx/gpt-5.5" }],
      }),
    );
    process.env.HERMES_PROFILES_REGISTRY = registry;

    // Inject a fake executor so the bridge never spawns systemctl.
    const control = await import("@/server/agents/control");
    calls = [];
    control.setExecutorForTests(async (argv) => {
      calls.push([...argv]);
      const [verb, unit] = argv;
      if (verb === "is-active") {
        // Gateway reports active so the post-action state derives "running".
        const word = unit === "cortex-agent-sample-agent.service" ? "active" : "inactive";
        return { stdout: `${word}\n`, stderr: "", exitCode: word === "active" ? 0 : 3 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const { agentActionGateOptions } = await import("../agents.functions");
    agentActionCore = defineApiRoute({
      methods: [agentActionGateOptions.method],
      auth: agentActionGateOptions.auth,
      input: agentActionGateOptions.input,
      rateLimit: agentActionGateOptions.rateLimit,
      surface: agentActionGateOptions.surface,
      action: agentActionGateOptions.action,
      target: agentActionGateOptions.target,
      approval: agentActionGateOptions.approval,
      handler: agentActionGateOptions.handler,
    });
  });

  afterEach(async () => {
    const control = await import("@/server/agents/control");
    control.setExecutorForTests(null);
    if (originalRegistry === undefined) delete process.env.HERMES_PROFILES_REGISTRY;
    else process.env.HERMES_PROFILES_REGISTRY = originalRegistry;
    try {
      fs.rmSync(agentTmpDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it("403 for an authenticated non-admin (with valid CSRF)", async () => {
    const { token, csrf } = await makeSession({ isAdmin: false });
    const res = await agentActionCore(
      new Request("http://localhost/_serverFn/agents.action", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        body: JSON.stringify({ slug: "sample-agent", action: "start" }),
      }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("permission");
    expect(calls).toHaveLength(0);
  });

  it("412 for an admin with valid CSRF but NO approval token", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const res = await agentActionCore(
      new Request("http://localhost/_serverFn/agents.action", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        body: JSON.stringify({ slug: "sample-agent", action: "start" }),
      }),
    );
    expect(res.status).toBe(412);
    expect((await res.json()).code).toBe("approval_required");
    expect(calls).toHaveLength(0);
  });

  it("201 for admin + CSRF + valid approval token starts the runtime once", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const resolved = (await store.resolveByToken(token))!;
    const approval = mintApproval({
      // Pipeline hashes actionHashFor("agents.action", { slug, action }).
      action: "agents.action",
      payload: { slug: "sample-agent", action: "start" },
      sessionId: resolved.session.id,
      userId: resolved.user.id,
    });

    const res = await agentActionCore(
      new Request("http://localhost/_serverFn/agents.action", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
          "x-csrf-token": csrf,
          "x-cortex-approval-token": approval.token,
        },
        body: JSON.stringify({ slug: "sample-agent", action: "start" }),
      }),
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({
      slug: "sample-agent",
      action: "start",
      status: "accepted",
      state: "running",
    });

    // A single unit start, without duplicate gateway/profile dispatch.
    const dispatched = calls.filter((c) => c[0] !== "is-active");
    expect(dispatched).toEqual([
      ["start", "cortex-agent-sample-agent.service"],
    ]);
  });

  it("404 for an unknown slug even with a valid approval token", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const resolved = (await store.resolveByToken(token))!;
    const approval = mintApproval({
      action: "agents.action",
      payload: { slug: "ghost", action: "start" },
      sessionId: resolved.session.id,
      userId: resolved.user.id,
    });
    const res = await agentActionCore(
      new Request("http://localhost/_serverFn/agents.action", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
          "x-csrf-token": csrf,
          "x-cortex-approval-token": approval.token,
        },
        body: JSON.stringify({ slug: "ghost", action: "start" }),
      }),
    );
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("not_found");
  });

  it("400 for a disallowed action verb", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const res = await agentActionCore(
      new Request("http://localhost/_serverFn/agents.action", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        body: JSON.stringify({ slug: "sample-agent", action: "kill" }),
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("validation");
  });
});
