// @vitest-environment node
/**
 * Agent control bridge tests (plan 0.5).
 *
 * Drives the REAL bridge with an injected fake executor (no spawning). Asserts:
 *   - unitsFor maps both systemd template units.
 *   - start/stop/restart issue systemctl for BOTH units; pause for the GATEWAY ONLY.
 *   - getAgentRuntime maps is-active outputs (active/inactive/failed) to the
 *     derived run-states per the operator rules.
 *   - unknown slug + the `../evil` traversal slug are rejected.
 *
 * The slug allowlist is the Hermes registry — pointed at a temp profiles.json
 * via HERMES_PROFILES_REGISTRY so only known slugs are controllable.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  AGENT_ACTIONS,
  unitsFor,
  getAgentRuntime,
  getAgentRuntimes,
  controlAgent,
  setExecutorForTests,
  UnknownAgentError,
  type Executor,
} from "@/server/agents/control";

// ---------------------------------------------------------------------------
// Fake executor — records every argv, returns canned is-active text + exit code
// ---------------------------------------------------------------------------

interface Call {
  argv: string[];
}

function makeExecutor(opts?: {
  /** Map unit name → is-active stdout word. */
  isActive?: Record<string, string>;
  /** Verbs (start/stop/restart) that should fail (exit 1) for a given unit. */
  failVerbForUnit?: { verb: string; unit: string; stderr: string };
}): { exec: Executor; calls: Call[] } {
  const calls: Call[] = [];
  const exec: Executor = async (argv) => {
    calls.push({ argv: [...argv] });
    const [verb, unit] = argv;
    if (verb === "is-active") {
      const word = opts?.isActive?.[unit] ?? "inactive";
      // is-active exits non-zero for inactive/failed; stdout carries the word.
      return { stdout: `${word}\n`, stderr: "", exitCode: word === "active" ? 0 : 3 };
    }
    if (
      opts?.failVerbForUnit &&
      opts.failVerbForUnit.verb === verb &&
      opts.failVerbForUnit.unit === unit
    ) {
      return { stdout: "", stderr: opts.failVerbForUnit.stderr, exitCode: 1 };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  return { exec, calls };
}

// ---------------------------------------------------------------------------
// Registry fixture
// ---------------------------------------------------------------------------

let tmpDir: string;
const originalEnv = process.env.HERMES_PROFILES_REGISTRY;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-agent-control-"));
  const registry = path.join(tmpDir, "profiles.json");
  fs.writeFileSync(
    registry,
    JSON.stringify({
      profiles: [
        { profile: "sample-agent", home: tmpDir, apiPort: 18700, model: "cx/gpt-5.5" },
        { profile: "cortex", home: tmpDir, apiPort: 18701, model: "cx/test" },
      ],
    }),
  );
  process.env.HERMES_PROFILES_REGISTRY = registry;
});

afterEach(() => {
  setExecutorForTests(null);
  if (originalEnv === undefined) delete process.env.HERMES_PROFILES_REGISTRY;
  else process.env.HERMES_PROFILES_REGISTRY = originalEnv;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

// ---------------------------------------------------------------------------
// unitsFor
// ---------------------------------------------------------------------------

describe("unitsFor", () => {
  it("maps a slug to its runtime unit", () => {
    expect(unitsFor("sample-agent")).toEqual({
      unit: "cortex-agent-sample-agent.service",
    });
  });
});

describe("AGENT_ACTIONS", () => {
  it("is exactly start/stop/restart/pause", () => {
    expect([...AGENT_ACTIONS]).toEqual(["start", "stop", "restart", "pause"]);
  });
});

// ---------------------------------------------------------------------------
// controlAgent — which units each action targets
// ---------------------------------------------------------------------------

describe("controlAgent verb → unit targeting", () => {
  it("start dispatches once to the runtime unit", async () => {
    const { exec, calls } = makeExecutor({ isActive: { "cortex-agent-sample-agent.service": "active" } });
    setExecutorForTests(exec);

    const res = await controlAgent("sample-agent", "start");

    const dispatched = calls.filter((c) => c.argv[0] !== "is-active").map((c) => c.argv);
    expect(dispatched).toEqual([
      ["start", "cortex-agent-sample-agent.service"],
    ]);
    expect(res.status).toBe("accepted");
    expect(res.state).toBe("running");
  });

  it("stop dispatches once to the runtime unit", async () => {
    const { exec, calls } = makeExecutor();
    setExecutorForTests(exec);

    await controlAgent("sample-agent", "stop");

    const dispatched = calls.filter((c) => c.argv[0] !== "is-active").map((c) => c.argv);
    expect(dispatched).toEqual([
      ["stop", "cortex-agent-sample-agent.service"],
    ]);
  });

  it("restart dispatches once to the runtime unit", async () => {
    const { exec, calls } = makeExecutor({ isActive: { "cortex-agent-sample-agent.service": "active" } });
    setExecutorForTests(exec);

    await controlAgent("sample-agent", "restart");

    const dispatched = calls.filter((c) => c.argv[0] !== "is-active").map((c) => c.argv);
    expect(dispatched).toEqual([
      ["restart", "cortex-agent-sample-agent.service"],
    ]);
  });

  it("pause stops the single runtime and reports stopped", async () => {
    const { exec, calls } = makeExecutor({
      isActive: { "cortex-agent-sample-agent.service": "inactive" },
    });
    setExecutorForTests(exec);

    const res = await controlAgent("sample-agent", "pause");

    const dispatched = calls.filter((c) => c.argv[0] !== "is-active").map((c) => c.argv);
    expect(dispatched).toEqual([["stop", "cortex-agent-sample-agent.service"]]);
    expect(res.state).toBe("stopped");
  });

  it("returns rejected with the stderr reason when a systemctl call fails", async () => {
    const { exec } = makeExecutor({
      failVerbForUnit: {
        verb: "start",
        unit: "cortex-agent-sample-agent.service",
        stderr: "Failed to start cortex-agent-sample-agent.service: unit not found",
      },
    });
    setExecutorForTests(exec);

    const res = await controlAgent("sample-agent", "start");
    expect(res.status).toBe("rejected");
    expect(res.reason).toContain("unit not found");
    const failing = res.units.find((u) => u.exitCode !== 0);
    expect(failing?.unit).toBe("cortex-agent-sample-agent.service");
  });
});

// ---------------------------------------------------------------------------
// getAgentRuntime — is-active → state derivation
// ---------------------------------------------------------------------------

describe("getAgentRuntime state derivation", () => {
  it("gateway active → running", async () => {
    const { exec } = makeExecutor({ isActive: { "cortex-agent-sample-agent.service": "active" } });
    setExecutorForTests(exec);
    expect((await getAgentRuntime("sample-agent")).state).toBe("running");
  });

  it("gateway failed → error", async () => {
    const { exec } = makeExecutor({ isActive: { "cortex-agent-sample-agent.service": "failed" } });
    setExecutorForTests(exec);
    expect((await getAgentRuntime("sample-agent")).state).toBe("error");
  });

  it("inactive runtime reports stopped", async () => {
    const { exec } = makeExecutor({
      isActive: {
        "cortex-agent-sample-agent.service": "inactive",
      },
    });
    setExecutorForTests(exec);
    expect((await getAgentRuntime("sample-agent")).state).toBe("stopped");
  });

  it("does NOT shell out for a malformed slug — returns stopped (defense-in-depth)", async () => {
    const { exec, calls } = makeExecutor({});
    setExecutorForTests(exec);
    // agents.status is auth:'any' and takes caller slugs; a slug that fails the
    // SLUG_RE format guard must never reach systemctl.
    const bad = ["bad slug!@#", "../etc/passwd", "a;b", "A_UPPER"];
    const states = await Promise.all(bad.map((s) => getAgentRuntime(s)));
    states.forEach((res) => expect(res.state).toBe("stopped"));
    expect(calls.length).toBe(0);
  });

  it("getAgentRuntimes derives many slugs in parallel", async () => {
    const { exec } = makeExecutor({
      isActive: {
        "cortex-agent-sample-agent.service": "active",
        "cortex-agent-cortex.service": "failed",
      },
    });
    setExecutorForTests(exec);
    const states = await getAgentRuntimes(["sample-agent", "cortex"]);
    expect(states).toEqual({ "sample-agent": "running", cortex: "error" });
  });
});

// ---------------------------------------------------------------------------
// Slug validation
// ---------------------------------------------------------------------------

describe("slug validation", () => {
  it("rejects an unknown slug (not in the registry)", async () => {
    const { exec, calls } = makeExecutor();
    setExecutorForTests(exec);
    await expect(controlAgent("ghost", "start")).rejects.toBeInstanceOf(UnknownAgentError);
    // No systemctl call should have been issued for an unknown slug.
    expect(calls).toHaveLength(0);
  });

  it("rejects a path-traversal slug `../evil` on the regex (before registry)", async () => {
    const { exec, calls } = makeExecutor();
    setExecutorForTests(exec);
    await expect(controlAgent("../evil", "start")).rejects.toBeInstanceOf(UnknownAgentError);
    expect(calls).toHaveLength(0);
  });

  it("getAgentRuntime does not validate (status probe is read-only) but unitsFor is safe", async () => {
    // unitsFor never interpolates a shell; it only builds the unit string.
    expect(unitsFor("cortex").unit).toBe("cortex-agent-cortex.service");
  });
});
