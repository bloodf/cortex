/**
 * Registered agent control bridge.
 *
 * Each registered agent is backed by one cortex-agent-<slug>.service unit.
 * Start, stop, restart, and pause act on that unit. Pause stops the gateway;
 * resuming starts it again.
 *
 * This bridge validates the slug against the agent registry and issues a
 * fixed `systemctl <verb> <unit>` argv. Only known agents are controllable.
 *
 * Executor injection (copied from `@/server/docker/bridge`): a module-level
 * `Executor` type + a default that shells out via `node:child_process execFile`
 * (no shell, no string interpolation), swappable in tests via
 * `setExecutorForTests`. The service runs as root (same as the systemd bridge,
 * which calls `/usr/bin/systemctl` directly — no sudo), so the default executor
 * invokes `/usr/bin/systemctl` with a fixed argv.
 *
 * Public surface:
 *   - AGENT_ACTIONS                         — readonly action tuple
 *   - unitsFor(slug)                        — { unit } runtime name
 *   - getAgentRuntime(slug)                 — derived run-state of one agent
 *   - getAgentRuntimes(slugs)               — slug → state map (parallel)
 *   - controlAgent(slug, action, ctx?)      — dispatch start/stop/restart/pause
 *   - setExecutorForTests(fn | null)        — test helper
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";
import { isMap, parseDocument } from "yaml";
import JSON5 from "json5";

import { findProfileBySlug, updateProfileModel } from "@/server/agents/registry";
import { validationError, systemError } from "@/server/errors/types";
import { audit } from "@/server/audit";
import { runSequentially } from "@/lib/sequential";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Public constants + types
// ---------------------------------------------------------------------------

/** The four control verbs the UI can dispatch. */
export const AGENT_ACTIONS = ["start", "stop", "restart", "pause"] as const;

export type AgentAction = (typeof AGENT_ACTIONS)[number];

/** Derived agent run-state, surfaced to the UI. */
export type AgentRuntimeState = "running" | "idle" | "stopped" | "error";

/** Slug validation: lowercase letters, digits, underscores, hyphens only. */
const SLUG_RE = /^[a-z0-9_-]+$/;

/** A per-unit systemctl result captured during a control dispatch. */
export interface AgentUnitResult {
  unit: string;
  exitCode: number;
  stderr: string;
}

/** The structured result `controlAgent` returns. Never throws on systemctl. */
export interface AgentControlResult {
  slug: string;
  action: AgentAction;
  status: "accepted" | "rejected";
  units: AgentUnitResult[];
  state: AgentRuntimeState;
  /** Present only on `rejected` — the first non-zero unit's stderr reason. */
  reason?: string;
}

/** Caller context for granular audit records (optional). */
export interface AgentControlContext {
  userId?: string | number | null;
  sessionId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string;
}

/**
 * Executor — the seam tests swap. Signature kept tiny so the bridge is
 * trivially testable: it receives the systemctl argv (verb + unit, or
 * `is-active <unit>`) and returns the captured streams + exit code.
 */
export type Executor = (argv: readonly string[]) => Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}>;

// ---------------------------------------------------------------------------
// Default executor — `/usr/bin/systemctl <argv...>` via execFile (no shell).
// ---------------------------------------------------------------------------

const SYSTEMCTL = "/usr/bin/systemctl";

const realSystemctlExecutor: Executor = async (argv) => {
  try {
    const { stdout, stderr } = await execFileAsync(SYSTEMCTL, [...argv], {
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { stdout: stdout ?? "", stderr: stderr ?? "", exitCode: 0 };
  } catch (err) {
    // `systemctl is-active` exits non-zero for inactive/failed units — that is
    // NOT an error for our purposes; the captured stdout text is authoritative.
    const e = err as {
      code?: number | string;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? e.message ?? "systemctl exec failed",
      exitCode: typeof e.code === "number" ? e.code : 1,
    };
  }
};

let executor: Executor = realSystemctlExecutor;

/** Test helper: swap the executor. Pass `null` to reset to the real one. */
export function setExecutorForTests(fn: Executor | null): void {
  executor = fn ?? realSystemctlExecutor;
}

// ---------------------------------------------------------------------------
// Unit naming + slug validation
// ---------------------------------------------------------------------------

/** Thrown by `assertKnownSlug` when a slug is malformed or not in the registry. */
export class UnknownAgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnknownAgentError";
  }
}

/** The single runtime unit backing an agent slug. */
export function unitsFor(slug: string): { unit: string } {
  const expected = `cortex-agent-${slug}.service`;
  const configured = findProfileBySlug(slug)?.unitName;
  if (configured && configured !== expected) {
    throw new UnknownAgentError(`agent '${slug}' has an invalid runtime unit`);
  }
  return { unit: expected };
}

/**
 * Validate a slug against the regex AND the Hermes registry. Only known
 * profiles are controllable. Throws `UnknownAgentError` otherwise.
 */
function assertKnownSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) {
    throw new UnknownAgentError(`agent slug '${slug}' does not match ${SLUG_RE.source}`);
  }
  if (!findProfileBySlug(slug)) {
    throw new UnknownAgentError(`agent '${slug}' is not a known Hermes profile`);
  }
}

// ---------------------------------------------------------------------------
// is-active → state derivation
// ---------------------------------------------------------------------------

/** Run `systemctl is-active <unit>`; return the trimmed status word. */
async function isActive(unit: string): Promise<string> {
  const res = await executor(["is-active", unit]);
  // is-active prints the state on stdout ('active'/'inactive'/'failed'/…) and
  // exits 3 for inactive — the stdout text is the source of truth, never throw.
  const text = (res.stdout || res.stderr || "").trim();
  return text || "inactive";
}

/** A single runtime is running, failed, or stopped; pause stops the unit. */
function deriveState(active: string): AgentRuntimeState {
  if (active === "active") return "running";
  if (active === "failed") return "error";
  return "stopped";
}

/**
 * Derive the run-state from one `systemctl is-active` probe.
 * Inactive exit statuses are captured rather than thrown.
 */
export async function getAgentRuntime(slug: string): Promise<{
  state: AgentRuntimeState;
  unit: string;
}> {
  const { unit } = unitsFor(slug);
  // Defense-in-depth: the read path takes caller-supplied slugs (agents.status
  // is auth:'any'). `isActive` already shells out via execFile with an argv
  // array — no shell injection is possible — but validate the slug format here
  // so an arbitrary string is never interpolated into a unit name and probed.
  if (!SLUG_RE.test(slug)) {
    return { state: "stopped", unit };
  }
  const active = await isActive(unit);
  return { state: deriveState(active), unit };
}

/** Derive run-state for many agents in parallel → slug → state map. */
export async function getAgentRuntimes(
  slugs: readonly string[],
): Promise<Record<string, AgentRuntimeState>> {
  const entries = await Promise.all(
    slugs.map(async (slug) => {
      const { state } = await getAgentRuntime(slug);
      return [slug, state] as const;
    }),
  );
  return Object.fromEntries(entries);
}

// ---------------------------------------------------------------------------
// controlAgent — dispatch a control verb to the agent's units
// ---------------------------------------------------------------------------

/** The systemctl verb + the units it targets for each action. */
function plan(
  action: AgentAction,
  units: { unit: string },
): {
  verb: string;
  targets: string[];
} {
  switch (action) {
    case "start":
      return { verb: "start", targets: [units.unit] };
    case "stop":
      return { verb: "stop", targets: [units.unit] };
    case "restart":
      return { verb: "restart", targets: [units.unit] };
    case "pause":
      // The single-unit runtime stops both channel intake and its API.
      return { verb: "stop", targets: [units.unit] };
    default:
      return { verb: "stop", targets: [] };
  }
}

function emitUnitAudit(
  ctx: AgentControlContext | undefined,
  action: AgentAction,
  unit: string,
  outcome: "success" | "failure",
  errorCode: string | null,
): void {
  audit({
    actorUserId: (ctx?.userId ?? null) as never,
    actorSessionId: (ctx?.sessionId ?? null) as never,
    actorIp: ctx?.ip ?? null,
    actorUserAgent: ctx?.userAgent ?? null,
    surface: "agents",
    action: "agents.control.dispatch",
    target: unit,
    result: outcome,
    errorCode,
    requestId: ctx?.requestId,
    payload: { action, unit },
  });
}

/**
 * Dispatch a control verb to the agent's single runtime unit.
 * Pause uses stop; no separate profile API is left running.
 *
 * Validates the slug first (regex + registry). On any non-zero systemctl exit
 * the overall status is `rejected` with the first failing unit's stderr.
 * Returns the freshly-derived run-state. Never throws on systemctl failure.
 */
export async function controlAgent(
  slug: string,
  action: AgentAction,
  ctx?: AgentControlContext,
): Promise<AgentControlResult> {
  assertKnownSlug(slug);
  if (!AGENT_ACTIONS.includes(action)) {
    throw new UnknownAgentError(`unknown agent action '${action}'`);
  }

  const units = unitsFor(slug);
  const { verb, targets } = plan(action, units);

  // Dispatch the planned runtime action through the fixed-argv executor.
  const results: AgentUnitResult[] = await runSequentially(targets, async (unit) => {
    // Fixed argv — no shell, no interpolation (verb + validated unit name).
    const res = await executor([verb, unit]);
    emitUnitAudit(
      ctx,
      action,
      unit,
      res.exitCode === 0 ? "success" : "failure",
      res.exitCode === 0 ? null : "systemctl_nonzero",
    );
    return { unit, exitCode: res.exitCode, stderr: res.stderr };
  });

  const failed = results.find((r) => r.exitCode !== 0);
  const { state } = await getAgentRuntime(slug);

  if (failed) {
    return {
      slug,
      action,
      status: "rejected",
      units: results,
      state,
      reason: failed.stderr.trim() || `systemctl ${verb} ${failed.unit} failed`,
    };
  }

  return { slug, action, status: "accepted", units: results, state };
}

// ---------------------------------------------------------------------------
// setAgentModel — change a profile's model + reasoning (P1.3)
// ---------------------------------------------------------------------------

export const AGENT_REASONING_LEVELS = ["low", "medium", "high"] as const;
export type AgentReasoning = (typeof AGENT_REASONING_LEVELS)[number];

export interface SetAgentModelInput {
  model: string;
  reasoning: AgentReasoning;
}
export interface SetAgentModelResult {
  slug: string;
  model: string;
  reasoning: AgentReasoning;
  restarted: { unit: string; exitCode: number }[];
}

/**
 * Persist runtime-native model and reasoning configuration, refresh the
 * registry, then restart the agent's single unit. Existing sessions may
 * retain explicit per-session model or reasoning overrides.
 */
export async function setAgentModel(
  slug: string,
  input: SetAgentModelInput,
  ctx?: AgentControlContext,
): Promise<SetAgentModelResult> {
  assertKnownSlug(slug);
  if (!AGENT_REASONING_LEVELS.includes(input.reasoning)) {
    throw validationError(`unknown reasoning '${input.reasoning}'`, [
      { field: "reasoning", message: "must be one of low, medium, high" },
    ]);
  }

  const profile = findProfileBySlug(slug);
  if (!profile) {
    // assertKnownSlug already covered this; narrow for TS.
    throw new UnknownAgentError(`agent '${slug}' is not a known Hermes profile`);
  }

  const units = unitsFor(slug);
  const openclaw = profile.runtime === "openclaw";
  const configPath = `${profile.home}/${openclaw ? "openclaw.json" : "config.yaml"}`;
  const configText = (() => {
    try {
      return fs.readFileSync(configPath, "utf8");
    } catch {
      throw validationError("profile_config_missing");
    }
  })();
  let nextConfig: string;
  try {
    if (openclaw) {
      const config = JSON5.parse(configText);
      if (!config || typeof config !== "object" || Array.isArray(config)) {
        throw new Error("invalid config object");
      }
      config.agents ??= {};
      config.agents.defaults ??= {};
      const {defaults} = config.agents;
      defaults.model = {
        ...(typeof defaults.model === "object" && defaults.model !== null ? defaults.model : {}),
        primary: input.model,
      };
      defaults.thinkingDefault = input.reasoning;
      nextConfig = `${JSON.stringify(config, null, 2)}\n`;
    } else {
      const config = parseDocument(configText);
      if (config.errors.length > 0 || !isMap(config.contents) || !isMap(config.get("model", true))) {
        throw new Error("invalid model config");
      }
      config.setIn(["model", "default"], input.model);
      config.setIn(["agent", "reasoning_effort"], input.reasoning);
      // Exact model overrides win over global effort and spelling aliases.
      config.setIn(["agent", "reasoning_overrides", input.model], input.reasoning);
      nextConfig = config.toString();
    }
  } catch {
    throw validationError("profile_config_malformed");
  }
  const metadata = fs.statSync(configPath);
  const temporary = `${configPath}.cortex-tmp`;
  const fd = fs.openSync(
    temporary,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o600,
  );
  const created = fs.fstatSync(fd);
  try {
    fs.writeFileSync(fd, nextConfig);
    fs.fchownSync(fd, metadata.uid, metadata.gid);
    fs.fchmodSync(fd, metadata.mode & 0o777);
    fs.fsyncSync(fd);
    const pending = fs.lstatSync(temporary);
    if (!pending.isFile() || pending.dev !== created.dev || pending.ino !== created.ino) {
      throw systemError("profile_config_temporary_replaced");
    }
    fs.renameSync(temporary, configPath);
  } finally {
    fs.closeSync(fd);
    try {
      const pending = fs.lstatSync(temporary);
      if (pending.isFile() && pending.dev === created.dev && pending.ino === created.ino) {
        fs.unlinkSync(temporary);
      }
    } catch {
      // Successful rename leaves no temporary entry; never remove another inode.
    }
  }

  // Keep the registry fresh so the UI list reflects the swap immediately.
  updateProfileModel(slug, { model: input.model, reasoning: input.reasoning });

  const restarted = await runSequentially([units.unit], async (unit) => {
    const res = await executor(["restart", unit]);
    emitUnitAudit(
      ctx,
      "restart",
      unit,
      res.exitCode === 0 ? "success" : "failure",
      res.exitCode === 0 ? null : "systemctl_nonzero",
    );
    return { unit, exitCode: res.exitCode };
  });

  const failed = restarted.find((r) => r.exitCode !== 0);
  if (failed) {
    throw systemError(`restart ${failed.unit} failed (exit ${failed.exitCode})`);
  }

  return { slug, model: input.model, reasoning: input.reasoning, restarted };
}
