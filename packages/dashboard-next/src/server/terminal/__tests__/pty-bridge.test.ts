// @vitest-environment node
/**
 * WP-19 — Terminal PTY bridge unit tests.
 *
 * Exercises the named-op `dispatch()` defence (allowlist → arg-smuggling →
 * argv-render → argv `<shell> -c` belt-and-braces → executor) and
 * `listTerminalOps()`. All tests run against the deterministic mock executor
 * (CORTEX_TERMINAL_BRIDGE_REAL=0) — no process spawn, no shell. `spawnPty` is
 * asserted to enforce the shell allowlist and to be transport-blocked
 * (`pty_unavailable`) until node-pty + a streaming route land.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";

import {
  dispatch,
  listTerminalOps,
  validateAllArgs,
  setExecutorForTests,
  spawnPty,
  ALLOWED_SHELLS,
  type DispatchContext,
  type Executor,
} from "../pty-bridge";
import { asUserId } from "../../entities";

beforeAll(() => {
  process.env.CORTEX_MASTER_KEY ??= "test-master-key-0123456789abcdef0123456789abcdef";
  // Force the deterministic mock executor regardless of platform.
  process.env.CORTEX_TERMINAL_BRIDGE_REAL = "0";
});

beforeEach(() => {
  setExecutorForTests(null);
});

afterEach(() => {
  setExecutorForTests(null);
});

function makeCtx(overrides: Partial<DispatchContext> = {}): DispatchContext {
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
// listTerminalOps
// ---------------------------------------------------------------------------

describe("listTerminalOps", () => {
  it("returns the terminal-surface allowlist with placeholders", () => {
    const ops = listTerminalOps();
    const names = ops.map((o) => o.op);
    expect(names).toContain("term.ps");
    expect(names).toContain("term.df");
    expect(names).toContain("term.ls");
    expect(names).toContain("term.tail_log");
    expect(names).not.toContain("term.exec_named");
    // term.tail_log renders <unit> + <N> placeholders.
    const tail = ops.find((o) => o.op === "term.tail_log");
    expect(tail?.placeholders).toEqual(expect.arrayContaining(["unit", "N"]));
    // term.ps has no placeholders.
    expect(ops.find((o) => o.op === "term.ps")?.placeholders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// dispatch — accepted path
// ---------------------------------------------------------------------------

describe("dispatch (accepted)", () => {
  it("runs a no-arg op (term.ps) via the mock executor", async () => {
    const res = await dispatch({ op: "term.ps", args: {} }, makeCtx());
    expect(res.status).toBe("accepted");
    if (res.status !== "accepted") return;
    expect(res.argv).toEqual(["ps", "auxf"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("ps auxf");
  });

  it("renders <placeholder> slots from keyed args (term.tail_log)", async () => {
    const res = await dispatch(
      { op: "term.tail_log", args: { unit: "caddy.service", N: 50 } },
      makeCtx(),
    );
    expect(res.status).toBe("accepted");
    if (res.status !== "accepted") return;
    expect(res.argv).toEqual(["journalctl", "-u", "caddy.service", "-n", "50", "--no-pager"]);
  });

  it("forwards a non-zero exit code without treating it as a rejection", async () => {
    const failing: Executor = async () => ({ stdout: "", stderr: "boom", exitCode: 3 });
    setExecutorForTests(failing);
    const res = await dispatch({ op: "term.ps", args: {} }, makeCtx());
    expect(res.status).toBe("accepted");
    if (res.status !== "accepted") return;
    expect(res.exitCode).toBe(3);
    expect(res.stderr).toBe("boom");
  });
});

// ---------------------------------------------------------------------------
// dispatch — rejected paths
// ---------------------------------------------------------------------------

describe("dispatch (rejected)", () => {
  it("rejects an unknown op", async () => {
    const res = await dispatch({ op: "term.nonexistent", args: {} }, makeCtx());
    expect(res.status).toBe("rejected");
    if (res.status !== "rejected") return;
    expect(res.code).toBe("unknown_op");
  });

  it("rejects a non-terminal surface op", async () => {
    const res = await dispatch({ op: "systemd.restart", args: { unit: "x" } }, makeCtx());
    expect(res.status).toBe("rejected");
    if (res.status !== "rejected") return;
    expect(res.code).toBe("unknown_op");
  });

  it("rejects a shell metacharacter in an arg (arg smuggling)", async () => {
    const res = await dispatch(
      { op: "term.tail_log", args: { unit: "caddy; rm -rf /", N: 10 } },
      makeCtx(),
    );
    expect(res.status).toBe("rejected");
    if (res.status !== "rejected") return;
    expect(res.code).toBe("arg_smuggling");
    expect(res.field).toContain("unit");
  });

  it("rejects command substitution in an arg", async () => {
    const res = await dispatch({ op: "term.ls", args: { path: "/etc/$(whoami)" } }, makeCtx());
    expect(res.status).toBe("rejected");
    if (res.status !== "rejected") return;
    expect(res.code).toBe("arg_smuggling");
  });

  it("rejects when a required placeholder is unbound", async () => {
    const res = await dispatch({ op: "term.ls", args: {} }, makeCtx());
    expect(res.status).toBe("rejected");
    if (res.status !== "rejected") return;
    expect(res.code).toBe("placeholder_unbound");
  });

  it("surfaces an executor throw as executor_error", async () => {
    const thrower: Executor = async () => {
      throw new Error("kaboom");
    };
    setExecutorForTests(thrower);
    const res = await dispatch({ op: "term.ps", args: {} }, makeCtx());
    expect(res.status).toBe("rejected");
    if (res.status !== "rejected") return;
    expect(res.code).toBe("executor_error");
    expect(res.reason).toContain("kaboom");
  });
});

// ---------------------------------------------------------------------------
// validateAllArgs (exported helper)
// ---------------------------------------------------------------------------

describe("validateAllArgs", () => {
  it("returns no hits for safe args", () => {
    expect(validateAllArgs({ unit: "caddy.service", N: 100 })).toEqual([]);
  });

  it("flags every unsafe string arg", () => {
    const hits = validateAllArgs({ a: "ok", b: "x | y", c: "z && w" });
    const fields = hits.map((h) => h.field);
    expect(fields).toContain("b");
    expect(fields).toContain("c");
    expect(fields).not.toContain("a");
  });
});

// ---------------------------------------------------------------------------
// spawnPty — allowlist + transport-blocked
// ---------------------------------------------------------------------------

describe("spawnPty", () => {
  it("rejects a shell not in the allowlist before any spawn", async () => {
    await expect(spawnPty("/usr/bin/evil", 80, 24)).rejects.toThrow(/shell_not_allowed/);
  });

  it("is transport-blocked (pty_unavailable) for an allowlisted shell", async () => {
    // node-pty is not installed + no streaming route exists (ADR-001 / STATUS WP-19).
    await expect(spawnPty("/bin/bash", 80, 24)).rejects.toThrow(/pty_unavailable/);
  });

  it("exposes a fixed shell allowlist", () => {
    expect([...ALLOWED_SHELLS]).toEqual(["/bin/bash", "/bin/sh", "/usr/bin/bash", "/usr/bin/zsh"]);
  });
});
