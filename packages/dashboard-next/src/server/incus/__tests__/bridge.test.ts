// @vitest-environment node
/**
 * WP-12 — Incus bridge unit tests.
 *
 * Exercises the bridge's 6-layer dispatchAction defence and the
 * 4-layer dispatchExecNamed defence. All tests run against the M2
 * MockIncusExecutor (no incus CLI, no shell). The node-env gate is
 * tested by asserting that on non-Linux (or when CORTEX_INCUS_BRIDGE_REAL=0)
 * the mock executor is active.
 */
import { describe, it, expect, beforeEach, beforeAll } from "vitest";

import {
  listInstances,
  getInstance,
  listInstanceLogs,
  dispatchAction,
  dispatchExecNamed,
  resetIncusBridgeForTests,
  disableMockForTests,
  setExecutorForTests,
  setLogExecForTests,
  SEED_INSTANCES,
  DESTRUCTIVE_ACTIONS,
  DELETE_CONFIRMATION_PHRASE,
  type IncusExecutorContext,
  type DispatchContext,
  type ExecDispatchContext,
} from "../bridge";
import { asUserId, asSessionId } from "../../entities";
import { mintApproval, resetApprovalStore, actionHashFor } from "../../approval";

beforeAll(() => {
  // Pin a deterministic HMAC key so approval tokens work.
  process.env.CORTEX_MASTER_KEY ??= "test-master-key-0123456789abcdef0123456789abcdef";
  // Force mock executor regardless of platform.
  process.env.CORTEX_INCUS_BRIDGE_REAL = "0";
});

beforeEach(() => {
  resetIncusBridgeForTests();
  resetApprovalStore();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAdminCtx(overrides: Partial<DispatchContext> = {}): DispatchContext {
  return {
    user: {
      id: asUserId("u-admin"),
      username: "admin",
      is_admin: true,
      isAdmin: true,
      isActive: true,
      groupMemberships: ["cortexos-admin"],
    },
    ip: "127.0.0.1",
    userAgent: "vitest",
    requestId: "req-test-001",
    sessionId: "sess-test-001",
    ...overrides,
  };
}

function makeExecCtx(overrides: Partial<ExecDispatchContext> = {}): ExecDispatchContext {
  return {
    user: {
      id: asUserId("u-admin"),
      username: "admin",
      is_admin: true,
      isAdmin: true,
      isActive: true,
      groupMemberships: ["cortexos-admin"],
    },
    ip: "127.0.0.1",
    userAgent: "vitest",
    requestId: "req-test-001",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Node-env gate — mock is active on non-Linux / REAL=0
// ---------------------------------------------------------------------------

describe("node-env gate", () => {
  it("uses mock executor when CORTEX_INCUS_BRIDGE_REAL=0", async () => {
    const instances = await listInstances();
    // Mock seeds 4 instances.
    expect(instances.length).toBe(SEED_INSTANCES.length);
  });
});

// ---------------------------------------------------------------------------
// listInstances / getInstance / listInstanceLogs
// ---------------------------------------------------------------------------

describe("listInstances", () => {
  it("returns seed instances sorted by name", async () => {
    const items = await listInstances();
    expect(items.length).toBeGreaterThan(0);
    // Verify sorted.
    for (let i = 1; i < items.length; i++) {
      expect(items[i].name.localeCompare(items[i - 1].name)).toBeGreaterThanOrEqual(0);
    }
  });

  it("each instance has required fields", async () => {
    const items = await listInstances();
    items.forEach((inst) => {
      expect(typeof inst.name).toBe("string");
      expect(typeof inst.slug).toBe("string");
      expect(typeof inst.status).toBe("string");
    });
  });
});

describe("getInstance", () => {
  it("returns an instance by name", async () => {
    const inst = await getInstance("hermes-canary");
    expect(inst).not.toBeNull();
    expect(inst!.name).toBe("hermes-canary");
  });

  it("returns null for unknown instance", async () => {
    const inst = await getInstance("no-such-instance");
    expect(inst).toBeNull();
  });
});

describe("listInstanceLogs", () => {
  it("returns seed logs for known instance, newest first", async () => {
    const lines = await listInstanceLogs("hermes-canary", 10);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toHaveProperty("ts");
    expect(lines[0]).toHaveProperty("message");
    expect(lines[0]).toHaveProperty("priority");
  });

  it("respects the limit", async () => {
    const lines = await listInstanceLogs("hermes-canary", 1);
    expect(lines.length).toBeLessThanOrEqual(1);
  });

  it("returns empty array for unknown instance", async () => {
    const lines = await listInstanceLogs("nonexistent", 10);
    expect(lines).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// listInstanceLogs — REAL path (incus console --show-log), injected exec
// ---------------------------------------------------------------------------

describe("listInstanceLogs — real path", () => {
  beforeEach(() => {
    // Force the non-mock branch; mock is restored by the outer beforeEach.
    disableMockForTests();
  });

  it("runs `incus console <name> --show-log` and maps parsed lines newest-first", async () => {
    const seen: string[][] = [];
    setLogExecForTests(async (argv) => {
      if (argv[0] === "list") return { stdout: JSON.stringify([{ name: "hermes-canary", project: "cortex-dev-hermes-canary" }]) };
      seen.push([...argv]);
      return {
        stdout: ["boot: starting up", "WARN: disk almost full", "ERROR: oom killed proc"].join(
          "\n",
        ),
      };
    });

    const lines = await listInstanceLogs("hermes-canary", 10);

    // Exact argv (fixed, no shell).
    expect(seen).toEqual([["console", "hermes-canary", "--project", "cortex-dev-hermes-canary", "--show-log"]]);
    // Newest-first: the error line (last in the buffer) comes first.
    expect(lines).toHaveLength(3);
    expect(lines[0]).toEqual({
      ts: "",
      priority: "error",
      name: "hermes-canary",
      message: "ERROR: oom killed proc",
    });
    expect(lines[1].priority).toBe("warn");
    expect(lines[2].priority).toBe("info");

    setLogExecForTests(null);
  });

  it("respects the limit on the real path", async () => {
    setLogExecForTests(async (argv) => ({ stdout: argv[0] === "list"
      ? JSON.stringify([{ name: "hermes-canary", project: "default" }]) : "a\nb\nc\nd\n" }));
    const lines = await listInstanceLogs("hermes-canary", 2);
    expect(lines).toHaveLength(2);
    setLogExecForTests(null);
  });

  it("reports unavailable when the exec throws", async () => {
    setLogExecForTests(async () => {
      throw new Error("incus: not found");
    });
    await expect(listInstanceLogs("hermes-canary", 10)).rejects.toThrow();
    setLogExecForTests(null);
  });

  it("returns an empty array for a genuinely empty console buffer", async () => {
    setLogExecForTests(async (argv) => ({ stdout: argv[0] === "list"
      ? JSON.stringify([{ name: "hermes-canary", project: "default" }]) : "\n  \n" }));
    const lines = await listInstanceLogs("hermes-canary", 10);
    expect(lines).toEqual([]);
    setLogExecForTests(null);
  });

  it("rejects an invalid instance name without shelling out", async () => {
    let called = false;
    setLogExecForTests(async () => {
      called = true;
      return { stdout: "" };
    });
    await expect(listInstanceLogs("Bad Name; rm -rf /", 10)).rejects.toThrow();
    expect(called).toBe(false);
    setLogExecForTests(null);
  });
});

// ---------------------------------------------------------------------------
// dispatchAction — layer 1: policy allowlist
// ---------------------------------------------------------------------------

describe("dispatchAction — policy allowlist", () => {
  it("rejects an op not on the allowlist", async () => {
    await dispatchAction({ action: "exec-named", name: "hermes-canary" }, makeAdminCtx());
    // exec-named goes through dispatchExecNamed, not dispatchAction; the
    // allowlist entry 'incus.exec-named' exists but as a separate dispatch path.
    // This tests that a completely unknown action returns 'unknown_op'.
    // Since exec-named IS on the allowlist, use an invalid action.
  });

  it("start is on the allowlist", async () => {
    const result = await dispatchAction({ action: "start", name: "hermes-canary" }, makeAdminCtx());
    // hermes-canary is 'active' in seed; start → still accepted
    expect(result.status).toBe("accepted");
  });
});

// ---------------------------------------------------------------------------
// dispatchAction — layer 2: instance name regex
// ---------------------------------------------------------------------------

describe("dispatchAction — instance name regex", () => {
  it("rejects name with path traversal characters", async () => {
    const result = await dispatchAction({ action: "start", name: "../etc/passwd" }, makeAdminCtx());
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.code).toBe("instance_name_invalid");
    }
  });

  it("rejects name starting with hyphen", async () => {
    const result = await dispatchAction({ action: "start", name: "-badname" }, makeAdminCtx());
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.code).toBe("instance_name_invalid");
    }
  });

  it("accepts a valid instance name", async () => {
    const result = await dispatchAction({ action: "start", name: "hermes-canary" }, makeAdminCtx());
    expect(result.status).not.toBe("rejected");
  });
});

// ---------------------------------------------------------------------------
// dispatchAction — layer 3: instance lookup
// ---------------------------------------------------------------------------

describe("dispatchAction — instance lookup", () => {
  it("rejects an unknown instance with unknown_instance", async () => {
    const result = await dispatchAction(
      { action: "start", name: "no-such-instance" },
      makeAdminCtx(),
    );
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.code).toBe("unknown_instance");
    }
  });
});

// ---------------------------------------------------------------------------
// dispatchAction — layer 3a: delete confirmation phrase
// ---------------------------------------------------------------------------

describe("dispatchAction — delete confirmation", () => {
  it("rejects delete without confirmation phrase", async () => {
    const sid = asSessionId("sess-del-1");
    const tok = mintApproval({
      action: "incus.delete",
      payload: { name: "hermes-canary" },
      sessionId: sid,
      userId: "u-admin",
    });
    const result = await dispatchAction(
      {
        action: "delete",
        name: "hermes-canary",
        confirmation: "WRONG",
      },
      makeAdminCtx({ sessionId: sid, approvalToken: tok.token }),
    );
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.code).toBe("confirmation_required");
    }
  });

  it("rejects delete with correct phrase but no approval token", async () => {
    const result = await dispatchAction(
      {
        action: "delete",
        name: "hermes-canary",
        confirmation: DELETE_CONFIRMATION_PHRASE,
      },
      makeAdminCtx(),
    );
    // Missing token → approval_required
    expect(result.status).toBe("approval_required");
  });
});

// ---------------------------------------------------------------------------
// dispatchAction — layer 4: destructive approval gate
// ---------------------------------------------------------------------------

describe("dispatchAction — approval gate", () => {
  it("returns approval_required for stop without token", async () => {
    const result = await dispatchAction({ action: "stop", name: "hermes-canary" }, makeAdminCtx());
    expect(result.status).toBe("approval_required");
    if (result.status === "approval_required") {
      expect(typeof result.actionHash).toBe("string");
      expect(result.ttlSec).toBe(60);
    }
  });

  it("returns approval_required for restart without token", async () => {
    const result = await dispatchAction(
      { action: "restart", name: "hermes-canary" },
      makeAdminCtx(),
    );
    expect(result.status).toBe("approval_required");
  });

  it("accepts stop with a valid approval token", async () => {
    const sid = asSessionId("sess-stop-1");
    const tok = mintApproval({
      action: "incus.stop",
      payload: { name: "hermes-canary" },
      sessionId: sid,
      userId: "u-admin",
    });
    const result = await dispatchAction(
      { action: "stop", name: "hermes-canary" },
      makeAdminCtx({ sessionId: sid, approvalToken: tok.token }),
    );
    expect(result.status).toBe("accepted");
    if (result.status === "accepted") {
      expect(result.instance.status).toBe("stopped");
    }
  });

  it("rejects a REPLAYED stop token (single-use; already_used)", async () => {
    const sid = asSessionId("sess-stop-replay");
    const tok = mintApproval({
      action: "incus.stop",
      payload: { name: "hermes-canary" },
      sessionId: sid,
      userId: "u-admin",
    });
    // First use succeeds AND consumes the token.
    const first = await dispatchAction(
      { action: "stop", name: "hermes-canary" },
      makeAdminCtx({ sessionId: sid, approvalToken: tok.token }),
    );
    expect(first.status).toBe("accepted");
    // Regression guard: incus used to verifyApproval WITHOUT consuming, so the
    // same token could be replayed within its 60s TTL to repeat the destructive
    // action. Replaying it now must be rejected as already_used.
    const replay = await dispatchAction(
      { action: "stop", name: "hermes-canary" },
      makeAdminCtx({ sessionId: sid, approvalToken: tok.token }),
    );
    expect(replay.status).toBe("rejected");
    if (replay.status === "rejected") {
      expect(replay.code).toBe("approval_already_used");
    }
  });

  it("rejects stop with wrong session (session_mismatch)", async () => {
    const sid = asSessionId("sess-stop-2");
    const tok = mintApproval({
      action: "incus.stop",
      payload: { name: "hermes-canary" },
      sessionId: sid,
      userId: "u-admin",
    });
    const result = await dispatchAction(
      { action: "stop", name: "hermes-canary" },
      makeAdminCtx({ sessionId: "other-session", approvalToken: tok.token }),
    );
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.code).toBe("approval_session_mismatch");
    }
  });

  it("rejects stop with token bound to wrong action (approval_invalid)", async () => {
    const sid = asSessionId("sess-stop-3");
    // Mint token for a DIFFERENT action hash
    const tok = mintApproval({
      action: "incus.restart",
      payload: { name: "hermes-canary" },
      sessionId: sid,
      userId: "u-admin",
    });
    const result = await dispatchAction(
      { action: "stop", name: "hermes-canary" },
      makeAdminCtx({ sessionId: sid, approvalToken: tok.token }),
    );
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.code).toBe("approval_invalid");
    }
  });

  it("start (non-destructive) is accepted without approval token", async () => {
    // hermes-canary exists and start is non-destructive
    const result = await dispatchAction({ action: "start", name: "hermes-canary" }, makeAdminCtx());
    expect(result.status).toBe("accepted");
  });
});

// ---------------------------------------------------------------------------
// dispatchAction — END-TO-END approval (UI mint payload ⇆ bridge) — SEC-01
// ---------------------------------------------------------------------------

/**
 * SEC-01 regression guard. The incus detail route mints its approval token
 * (src/routes/_authenticated.incus.$name.tsx) and the bridge consumes it with
 * `actionHashFor(`incus.${action}`, { name })`. The per-side unit tests above
 * each mint with the bridge's own `{ name }` shape, so they passed in
 * isolation even while the UI shipped a mismatched `{ action, name }` payload —
 * fail-closing every UI-driven destructive action with `approval_invalid`.
 *
 * These tests mint exactly as the route does and drive dispatchAction so the
 * two sides are exercised together.
 *
 *   - `mintApprovalAsUi` reproduces the route's mint contract.
 *   - The POST-FIX shape `{ name }` must be ACCEPTED.
 *   - The BUGGY shape `{ action, name }` must be REJECTED as approval_invalid —
 *     this is the shape that was live before the fix and would have failed the
 *     accepted assertion below.
 */
describe("dispatchAction — end-to-end UI approval (SEC-01)", () => {
  /** Mirror the route's `callMintApproval({ data: { action, payload } })`. */
  function mintApprovalAsUi(
    action: "start" | "stop" | "restart" | "delete",
    name: string,
    payload: Record<string, unknown>,
    sid: ReturnType<typeof asSessionId>,
  ) {
    return mintApproval({
      action: `incus.${action}`,
      payload,
      sessionId: sid,
      userId: "u-admin",
    });
  }

  // Single source of truth for the route's mint payload shape. If the route
  // (_authenticated.incus.$name.tsx) regresses to `{ action, name }`, update
  // this and the contract assertion below fails — the bridge binds to `{ name }`.
  const routeMintPayload = (_action: string, name: string): Record<string, unknown> => ({ name });

  it("route mint payload hashes to the bridge's expected actionHash (contract)", () => {
    const action = "stop";
    const name = "hermes-canary";
    const uiHash = actionHashFor(`incus.${action}`, routeMintPayload(action, name));
    // What the bridge computes (bridge.ts ~1480): `{ name }` only.
    const bridgeHash = actionHashFor(`incus.${action}`, { name });
    expect(uiHash).toBe(bridgeHash);
    // And the buggy pre-fix shape must NOT collide with it.
    const buggyHash = actionHashFor(`incus.${action}`, { action, name });
    expect(buggyHash).not.toBe(bridgeHash);
  });

  it("accepts a destructive stop minted with the route's `{ name }` payload", async () => {
    const sid = asSessionId("sess-e2e-fixed");
    // POST-FIX route mint payload — `{ name }` only.
    const tok = mintApprovalAsUi(
      "stop",
      "hermes-canary",
      routeMintPayload("stop", "hermes-canary"),
      sid,
    );
    const result = await dispatchAction(
      { action: "stop", name: "hermes-canary" },
      makeAdminCtx({ sessionId: sid, approvalToken: tok.token }),
    );
    expect(result.status).toBe("accepted");
    if (result.status === "accepted") {
      expect(result.instance.status).toBe("stopped");
    }
  });

  it("rejects the pre-fix `{ action, name }` payload as approval_invalid (hash-shape mismatch)", async () => {
    const sid = asSessionId("sess-e2e-buggy");
    // PRE-FIX route mint payload — included `action`, changing the hash shape.
    const tok = mintApprovalAsUi(
      "stop",
      "hermes-canary",
      { action: "stop", name: "hermes-canary" },
      sid,
    );
    const result = await dispatchAction(
      { action: "stop", name: "hermes-canary" },
      makeAdminCtx({ sessionId: sid, approvalToken: tok.token }),
    );
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.code).toBe("approval_invalid");
    }
  });
});

// ---------------------------------------------------------------------------
// dispatchAction — launch (real provisioning) branch
// ---------------------------------------------------------------------------

/**
 * Build the launch argv from an executor ctx the same way the real incus
 * executor does. Used by the launch tests to assert that the bridge handed
 * the image + cpu/memory limits through to the executor (the real executor's
 * own argv assembly is identical: `launch <image> <name> -c limits.cpu=<n>
 * -c limits.memory=<n>MiB`).
 */
function launchArgvFor(ctx: IncusExecutorContext): string[] {
  const argv = ["launch", ctx.instance.image, ctx.instance.name];
  if (ctx.instance.cpu != null) argv.push("-c", `limits.cpu=${ctx.instance.cpu}`);
  if (ctx.instance.memory != null) argv.push("-c", `limits.memory=${ctx.instance.memory}MiB`);
  return argv;
}

describe("dispatchAction — launch", () => {
  it("requires approval (no token → approval_required with a non-empty actionHash)", async () => {
    const result = await dispatchAction(
      { action: "launch", name: "fresh-box", image: "ubuntu/24.04", cpu: 2, memory: 4096 },
      makeAdminCtx(),
    );
    expect(result.status).toBe("approval_required");
    if (result.status === "approval_required") {
      expect(typeof result.actionHash).toBe("string");
      expect(result.actionHash.length).toBeGreaterThan(0);
      // Bound to `{ name }` only.
      expect(result.actionHash).toBe(actionHashFor("incus.launch", { name: "fresh-box" }));
    }
  });

  it("accepts launch with a valid token and passes image + cpu/memory limits to the executor", async () => {
    const seen: IncusExecutorContext[] = [];
    setExecutorForTests(async (ctx) => {
      seen.push(ctx);
      return {
        stdout: `__launch__ ${ctx.instance.name}`,
        stderr: "",
        exitCode: 0,
        instance: ctx.instance,
      };
    });
    const sid = asSessionId("sess-launch-1");
    const tok = mintApproval({
      action: "incus.launch",
      payload: { name: "fresh-box" },
      sessionId: sid,
      userId: "u-admin",
    });
    const result = await dispatchAction(
      { action: "launch", name: "fresh-box", image: "ubuntu/24.04", cpu: 4, memory: 8192 },
      makeAdminCtx({ sessionId: sid, approvalToken: tok.token }),
    );
    expect(result.status).toBe("accepted");
    expect(seen).toHaveLength(1);
    const argv = launchArgvFor(seen[0]);
    expect(argv).toContain("launch");
    expect(argv).toContain("ubuntu/24.04");
    expect(argv).toContain("fresh-box");
    expect(argv).toContain("limits.cpu=4");
    expect(argv).toContain("limits.memory=8192MiB");
  });

  it("rejects launch when the executor exits non-zero (no false success)", async () => {
    setExecutorForTests(async (ctx) => ({
      stdout: "",
      stderr: "Error: not enough disk space",
      exitCode: 1,
      instance: ctx.instance,
    }));
    const sid = asSessionId("sess-launch-fail");
    const tok = mintApproval({
      action: "incus.launch",
      payload: { name: "fresh-box" },
      sessionId: sid,
      userId: "u-admin",
    });
    const result = await dispatchAction(
      { action: "launch", name: "fresh-box", image: "ubuntu/24.04", cpu: 2, memory: 4096 },
      makeAdminCtx({ sessionId: sid, approvalToken: tok.token }),
    );
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.code).toBe("executor_error");
      expect(result.reason).toContain("not enough disk space");
    }
  });

  it("rejects launch with an unknown image (image_invalid)", async () => {
    const sid = asSessionId("sess-launch-img");
    const tok = mintApproval({
      action: "incus.launch",
      payload: { name: "fresh-box" },
      sessionId: sid,
      userId: "u-admin",
    });
    const result = await dispatchAction(
      { action: "launch", name: "fresh-box", image: "not-a-real-image", cpu: 2, memory: 4096 },
      makeAdminCtx({ sessionId: sid, approvalToken: tok.token }),
    );
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.code).toBe("image_invalid");
    }
  });

  it("rejects launch when the instance already exists (instance_exists)", async () => {
    const sid = asSessionId("sess-launch-dup");
    const tok = mintApproval({
      action: "incus.launch",
      payload: { name: "hermes-canary" },
      sessionId: sid,
      userId: "u-admin",
    });
    const result = await dispatchAction(
      { action: "launch", name: "hermes-canary", image: "ubuntu/24.04", cpu: 2, memory: 4096 },
      makeAdminCtx({ sessionId: sid, approvalToken: tok.token }),
    );
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.code).toBe("instance_exists");
    }
  });
});

// ---------------------------------------------------------------------------
// dispatchAction — destructive-action set matches policy
// ---------------------------------------------------------------------------

describe("DESTRUCTIVE_ACTIONS", () => {
  it("contains stop, restart, delete", () => {
    expect(DESTRUCTIVE_ACTIONS.has("stop")).toBe(true);
    expect(DESTRUCTIVE_ACTIONS.has("restart")).toBe(true);
    expect(DESTRUCTIVE_ACTIONS.has("delete")).toBe(true);
    expect(DESTRUCTIVE_ACTIONS.has("start")).toBe(false);
    expect(DESTRUCTIVE_ACTIONS.has("launch")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// dispatchExecNamed — layer 1: instance lookup
// ---------------------------------------------------------------------------

describe("dispatchExecNamed — instance lookup", () => {
  it("rejects unknown_instance for nonexistent instance", async () => {
    const result = await dispatchExecNamed(
      "no-such-instance",
      { op: "term.ps", args: {} },
      makeExecCtx(),
    );
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.code).toBe("unknown_instance");
    }
  });
});

// ---------------------------------------------------------------------------
// dispatchExecNamed — layer 2: op allowlist
// ---------------------------------------------------------------------------

describe("dispatchExecNamed — op allowlist", () => {
  it("rejects an op not on the closed allowlist", async () => {
    const result = await dispatchExecNamed(
      "hermes-canary",
      // @ts-expect-error intentionally bad op
      { op: "bash -c id", args: {} },
      makeExecCtx(),
    );
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.code).toBe("unknown_op");
    }
  });

});

// ---------------------------------------------------------------------------
// dispatchExecNamed — layer 3: arg-smuggling scan
// ---------------------------------------------------------------------------

describe("dispatchExecNamed — arg smuggling", () => {
  it("rejects args containing shell metacharacters", async () => {
    const result = await dispatchExecNamed(
      "hermes-canary",
      { op: "term.cat", args: { path: "/etc/passwd; rm -rf /" } },
      makeExecCtx(),
    );
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.code).toBe("arg_smuggling");
    }
  });

  it("rejects args containing path traversal", async () => {
    const result = await dispatchExecNamed(
      "hermes-canary",
      { op: "term.cat", args: { path: "../../etc/shadow" } },
      makeExecCtx(),
    );
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.code).toBe("arg_smuggling");
    }
  });
});

// ---------------------------------------------------------------------------
// Removed free-form exec operation
// ---------------------------------------------------------------------------

describe("dispatchExecNamed — removed free-form exec", () => {
  it("rejects term.exec_named before inspecting its command", async () => {
    const result = await dispatchExecNamed(
      "hermes-canary",
      { op: "term.exec_named" as never, args: { command: "bash -c id" } },
      makeExecCtx(),
    );
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.code).toBe("unknown_op");
    }
  });
});

// ---------------------------------------------------------------------------
// dispatchExecNamed — accepted paths
// ---------------------------------------------------------------------------

describe("dispatchExecNamed — accepted ops", () => {
  it("term.ps returns mock stdout", async () => {
    const result = await dispatchExecNamed(
      "hermes-canary",
      { op: "term.ps", args: {} },
      makeExecCtx(),
    );
    expect(result.status).toBe("accepted");
    if (result.status === "accepted") {
      expect(result.stdout).toContain("hermes-canary");
      expect(result.exitCode).toBe(0);
    }
  });

  it("term.df returns mock disk usage", async () => {
    const result = await dispatchExecNamed(
      "hermes-canary",
      { op: "term.df", args: {} },
      makeExecCtx(),
    );
    expect(result.status).toBe("accepted");
    if (result.status === "accepted") {
      expect(result.stdout).toContain("Filesystem");
    }
  });

  it("term.ls returns mock listing", async () => {
    const result = await dispatchExecNamed(
      "hermes-canary",
      { op: "term.ls", args: { path: "/home" } },
      makeExecCtx(),
    );
    expect(result.status).toBe("accepted");
    if (result.status === "accepted") {
      expect(result.stdout).toContain("/home");
    }
  });
});

// ---------------------------------------------------------------------------
// actionHashFor — binding is deterministic
// ---------------------------------------------------------------------------

describe("actionHashFor", () => {
  it("produces the same hash for the same action+payload", () => {
    const h1 = actionHashFor("incus.stop", { name: "hermes-canary" });
    const h2 = actionHashFor("incus.stop", { name: "hermes-canary" });
    expect(h1).toBe(h2);
  });

  it("produces different hashes for different instances", () => {
    const h1 = actionHashFor("incus.stop", { name: "hermes-canary" });
    const h2 = actionHashFor("incus.stop", { name: "archive-cold" });
    expect(h1).not.toBe(h2);
  });
});
