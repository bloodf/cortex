// @vitest-environment node
/**
 * Docker bridge dispatch tests — SEC-02 flag-spoofing hardening + dispatch
 * security coverage.
 *
 * Drives `dispatch()` with an injected fake executor (no real docker, no
 * shell). incus neutralizes leading-dash flag-spoofing with its name regex and
 * systemd with an existence snapshot; docker previously did neither — a
 * `<container>` value like `-f` would be rendered straight into argv and parsed
 * by docker as a flag. These tests pin the two restrictive defences:
 *
 *   1. renderArgv rejects any placeholder value starting with `-`
 *      (`leading_dash`), BEFORE the approval gate.
 *   2. the docker templates carry a literal `--` end-of-options token before
 *      the first caller-controlled positional, so even a benign value can't be
 *      mis-parsed as a flag.
 *
 * Additional dispatch-level security cases (wave-2):
 *   3. Unknown op → unknown_op rejection, executor never called.
 *   4. No approval token → missing_approval, executor never called.
 *   5. Single-use enforcement — second dispatch with same token is rejected.
 *   6. Action-hash mismatch — token minted for different op is rejected.
 *   7. hasSmugglingPattern rejects a bash-c-style arg (arg_smuggling).
 *   8. Happy path — valid minted token produces accepted + correct argv.
 */

import { describe, it, expect, beforeAll, afterEach } from "vitest";

import {
  dispatch,
  internals,
  setExecutorForTests,
  type DispatchContext,
  type Executor,
} from "../bridge";
import { allowlistedCommand } from "../../policy";
import { asUserId, asSessionId } from "../../entities";
import { mintApproval, resetApprovalStore, actionHashFor } from "../../approval";

beforeAll(() => {
  // The approval module signs tokens with HMAC-SHA256 derived from CORTEX_MASTER_KEY.
  process.env.CORTEX_MASTER_KEY ??= "test-master-key-0123456789abcdef0123456789abcdef";
});

afterEach(() => {
  setExecutorForTests(null);
  resetApprovalStore();
});

function makeAdminCtx(): DispatchContext {
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
    requestId: "req-docker-sec02",
  };
}

// Records every argv the bridge issues so we can assert exact commands.
function recordingExecutor(): { exec: Executor; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Executor = async (argv) => {
    calls.push([...argv]);
    return { stdout: "ok", stderr: "", exitCode: 0 };
  };
  return { exec, calls };
}

describe("docker bridge SEC-02 — leading-dash flag-spoofing", () => {
  it("renderArgv rejects a `<container>` value starting with '-' (leading_dash)", () => {
    const entry = allowlistedCommand("docker.stop");
    expect(entry).toBeDefined();
    const r = internals.renderArgv(entry!, { container: "-f" });
    expect("code" in r && r.code).toBe("leading_dash");
    if ("code" in r) expect(r.field).toBe("container");
  });

  it("dispatch rejects a `<container>` of '-f' as leading_dash before any docker runs", async () => {
    const { exec, calls } = recordingExecutor();
    setExecutorForTests(exec);

    const res = await dispatch(
      { op: "docker.stop", args: { container: "-f" }, approvalToken: "irrelevant" },
      makeAdminCtx(),
    );

    expect(res.status).toBe("rejected");
    if (res.status === "rejected") expect(res.code).toBe("leading_dash");
    // The executor must never have been invoked.
    expect(calls).toHaveLength(0);
  });

  it("dispatch rejects a `--rm`-style `<command>` on docker.exec as leading_dash", async () => {
    const { exec, calls } = recordingExecutor();
    setExecutorForTests(exec);

    const res = await dispatch(
      {
        op: "docker.exec",
        args: { container: "grafana", command: "--privileged" },
        approvalToken: "x",
      },
      makeAdminCtx(),
    );

    expect(res.status).toBe("rejected");
    if (res.status === "rejected") expect(res.code).toBe("leading_dash");
    expect(calls).toHaveLength(0);
  });

  it("renders a benign `<container>` AFTER a literal `--` end-of-options token", async () => {
    const { exec, calls } = recordingExecutor();
    setExecutorForTests(exec);

    const sid = asSessionId("sess-docker-ok");
    const tok = mintApproval({
      action: "docker.stop",
      payload: { op: "docker.stop", args: { container: "grafana-1" } },
      sessionId: sid,
      userId: asUserId("u-admin"),
    });

    const res = await dispatch(
      {
        op: "docker.stop",
        args: { container: "grafana-1" },
        approvalToken: tok.token,
        sessionId: sid,
      },
      makeAdminCtx(),
    );

    expect(res.status).toBe("accepted");
    if (res.status === "accepted") {
      // `--` immediately precedes the caller-controlled positional.
      const dashIdx = res.argv.indexOf("--");
      expect(dashIdx).toBeGreaterThan(-1);
      expect(res.argv[dashIdx + 1]).toBe("grafana-1");
      expect(res.argv).toEqual(["/usr/bin/docker", "stop", "--", "grafana-1"]);
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("--");
  });
});

// ---------------------------------------------------------------------------
// dispatch — container-name / op validation
// ---------------------------------------------------------------------------

describe("docker dispatch — op and container-name validation", () => {
  it("rejects an unknown op with unknown_op, executor never called", async () => {
    const { exec, calls } = recordingExecutor();
    setExecutorForTests(exec);

    const res = await dispatch(
      { op: "docker.nuke", args: { container: "mycontainer" }, approvalToken: "irrelevant" },
      makeAdminCtx(),
    );

    expect(res.status).toBe("rejected");
    if (res.status === "rejected") expect(res.code).toBe("unknown_op");
    expect(calls).toHaveLength(0);
  });

  it("rejects a container name that contains shell metacharacters (arg_smuggling)", async () => {
    const { exec, calls } = recordingExecutor();
    setExecutorForTests(exec);

    // `&&` is a SMUGGLING_PATTERNS hit caught before leading-dash or approval.
    const res = await dispatch(
      {
        op: "docker.stop",
        args: { container: "mycontainer && rm -rf /" },
        approvalToken: "irrelevant",
      },
      makeAdminCtx(),
    );

    expect(res.status).toBe("rejected");
    if (res.status === "rejected") expect(res.code).toBe("arg_smuggling");
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// dispatch — approval-required path (no token)
// ---------------------------------------------------------------------------

describe("docker dispatch — approval_required (PB-5)", () => {
  it("returns missing_approval when no token is provided, executor never called", async () => {
    const { exec, calls } = recordingExecutor();
    setExecutorForTests(exec);

    // docker.stop requiresApproval; no approvalToken supplied.
    const res = await dispatch(
      { op: "docker.stop", args: { container: "mycontainer" } },
      makeAdminCtx(),
    );

    expect(res.status).toBe("rejected");
    if (res.status === "rejected") expect(res.code).toBe("missing_approval");
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// dispatch — approval replay / action-hash checks
// ---------------------------------------------------------------------------

describe("docker dispatch — approval single-use and action-hash enforcement", () => {
  it("rejects a replayed (already-consumed) token on the second dispatch", async () => {
    const { exec } = recordingExecutor();
    setExecutorForTests(exec);

    const sid = asSessionId("sess-docker-replay");
    const tok = mintApproval({
      action: "docker.stop",
      payload: { op: "docker.stop", args: { container: "mycontainer" } },
      sessionId: sid,
      userId: asUserId("u-admin"),
    });

    const input = {
      op: "docker.stop",
      args: { container: "mycontainer" },
      approvalToken: tok.token,
      sessionId: sid,
    } as const;
    const ctx = makeAdminCtx();

    // First use: should succeed.
    const first = await dispatch(input, ctx);
    expect(first.status).toBe("accepted");

    // Second use with the SAME token must be rejected.
    const second = await dispatch(input, ctx);
    expect(second.status).toBe("rejected");
    if (second.status === "rejected") expect(second.code).toBe("invalid_approval");
  });

  it("rejects a token whose action-hash was minted for a different op", async () => {
    const { exec, calls } = recordingExecutor();
    setExecutorForTests(exec);

    const sid = asSessionId("sess-docker-hash");
    // Mint a token for docker.restart but try to use it for docker.stop.
    const tok = mintApproval({
      action: "docker.restart",
      payload: { op: "docker.restart", args: { container: "mycontainer" } },
      sessionId: sid,
      userId: asUserId("u-admin"),
    });

    const res = await dispatch(
      {
        op: "docker.stop",
        args: { container: "mycontainer" },
        approvalToken: tok.token,
        sessionId: sid,
      },
      makeAdminCtx(),
    );

    expect(res.status).toBe("rejected");
    if (res.status === "rejected") expect(res.code).toBe("invalid_approval");
    // Executor must not have fired.
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// dispatch — hasSmugglingPattern rejects bash-c-style arg
// ---------------------------------------------------------------------------

describe("docker dispatch — hasSmugglingPattern (bash -c injection)", () => {
  it("rejects an arg containing 'bash -c' as arg_smuggling before approval check", async () => {
    const { exec, calls } = recordingExecutor();
    setExecutorForTests(exec);

    // The smuggling scan runs before the approval gate, so no valid token needed.
    const res = await dispatch(
      {
        op: "docker.exec",
        args: { container: "mycontainer", command: "bash -c id" },
        approvalToken: "irrelevant",
      },
      makeAdminCtx(),
    );

    expect(res.status).toBe("rejected");
    if (res.status === "rejected") expect(res.code).toBe("arg_smuggling");
    expect(calls).toHaveLength(0);
  });

  it("hasSmugglingPattern directly flags a 'bash -c' substring", () => {
    const hit = internals.hasSmugglingPattern("bash -c whoami");
    expect(hit).not.toBeNull();
    expect(hit?.reason).toMatch(/bash -c/);
  });
});

// ---------------------------------------------------------------------------
// dispatch — happy path: valid minted token → accepted + correct argv
// ---------------------------------------------------------------------------

describe("docker dispatch — successful dispatch with valid approval token", () => {
  it("calls fake executor with expected argv for docker.stop and returns accepted", async () => {
    const { exec, calls } = recordingExecutor();
    setExecutorForTests(exec);

    const sid = asSessionId("sess-docker-happy");
    const tok = mintApproval({
      action: "docker.stop",
      payload: { op: "docker.stop", args: { container: "mycontainer" } },
      sessionId: sid,
      userId: asUserId("u-admin"),
    });

    const res = await dispatch(
      {
        op: "docker.stop",
        args: { container: "mycontainer" },
        approvalToken: tok.token,
        sessionId: sid,
      },
      makeAdminCtx(),
    );

    expect(res.status).toBe("accepted");
    if (res.status === "accepted") {
      expect(res.argv).toEqual(["/usr/bin/docker", "stop", "--", "mycontainer"]);
      expect(res.output).toBe("ok");
    }
    // Executor was called exactly once with the rendered argv.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["/usr/bin/docker", "stop", "--", "mycontainer"]);
  });

  it("calls fake executor with expected argv for docker.rm and returns accepted", async () => {
    const { exec, calls } = recordingExecutor();
    setExecutorForTests(exec);

    const sid = asSessionId("sess-docker-rm");
    const tok = mintApproval({
      action: "docker.rm",
      payload: { op: "docker.rm", args: { container: "stale-container" } },
      sessionId: sid,
      userId: asUserId("u-admin"),
    });

    const res = await dispatch(
      {
        op: "docker.rm",
        args: { container: "stale-container" },
        approvalToken: tok.token,
        sessionId: sid,
      },
      makeAdminCtx(),
    );

    expect(res.status).toBe("accepted");
    if (res.status === "accepted") {
      expect(res.argv).toEqual(["/usr/bin/docker", "rm", "--", "stale-container"]);
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["/usr/bin/docker", "rm", "--", "stale-container"]);
  });
});
