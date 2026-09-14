/**
 * Systemd bridge — server-side dispatcher for systemd unit operations (WP-13).
 *
 * Ported from the legacy SvelteKit handlers:
 *   packages/dashboard/src/lib/server/systemd/bridge.ts
 *   packages/dashboard/src/routes/api/systemd/actions/+server.ts
 *   packages/dashboard/src/routes/(authed)/systemd/[name]/logs/+server.ts
 *
 * Hard rules (THREAT_MODEL §4.4.2 + PB-5 + SR-019):
 *   - Unit name is regex-validated against a strict pattern.
 *   - Destructive actions (restart, stop, disable) require an approval token
 *     (SR-120). The approval gate in defineServerFn carries this via
 *     `approval: true`; the bridge additionally verifies the token is bound
 *     to the correct action + unit name.
 *   - The real executor NEVER accepts a `bash -c <string>` argv. execFile is
 *     called with a fixed argv array; the unit name is a validated argument.
 *   - Production uses the real Linux executor. CORTEX_SYSTEMD_BRIDGE_REAL=0
 *     and executor injection are permitted only in NODE_ENV=test.
 *
 * Public surface:
 *   - listUnits()                       → SystemdUnit[]
 *   - getUnit(name)                     → SystemdUnit | null
 *   - listLogs(name, limit)             → SystemdLogLine[]
 *   - dispatchAction(input, ctx)        → DispatchResult (never throws)
 *   - setExecutorForTests(fn | null)    → test helper
 *   - resetSystemdBridgeForTests()      → test helper
 *   - getMockExecutorForTests()         → test helper
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  SystemdUnitSchema,
  SystemdLogLineSchema,
  type SystemdUnit,
  type SystemdLogLine,
  type SystemdActionKind,
  type SystemdActiveState,
  type SystemdLoadState,
} from "@cortexos/contracts";

import { actionHashFor, consumeApproval, mintApproval } from "@/server/approval";
import { audit } from "@/server/audit";
import type { User, SessionId } from "@/server/entities";

export { SystemdUnitSchema, SystemdLogLineSchema };

// ---------------------------------------------------------------------------
// Executor interface — the seam between M2 (mock) and M3 (real systemctl).
// ---------------------------------------------------------------------------

export interface UnitExecutorContext {
  unit: SystemdUnit;
  action: SystemdActionKind;
  user: User;
  ip: string;
  requestId: string;
}

export interface UnitExecutorResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Updated unit snapshot after the action (for optimistic UI updates). */
  unit: SystemdUnit;
}

export type UnitExecutor = (ctx: UnitExecutorContext) => Promise<UnitExecutorResult>;

// ---------------------------------------------------------------------------
// Mock executor (M2) — in-memory, deterministic, no shell.
// ---------------------------------------------------------------------------

/**
 * Apply a systemd action to a unit snapshot. Pure function. The mock executor
 * calls this to derive the next state; mirrors common-case systemctl semantics.
 */
export function applyAction(unit: SystemdUnit, action: SystemdActionKind): SystemdUnit {
  switch (action) {
    case "start":
      return { ...unit, active: "active", sub: "running" };
    case "stop":
      return { ...unit, active: "inactive", sub: "dead" };
    case "restart":
      return { ...unit, active: "active", sub: "running" };
    case "reload":
      return { ...unit, active: "active", sub: "running" };
    case "enable":
      return { ...unit, enabled: true };
    case "disable":
      return { ...unit, enabled: false };
    case "status":
    case "list-units":
      return { ...unit };
    default:
      return { ...unit };
  }
}

export class MockUnitExecutor {
  private readonly snapshots = new Map<string, SystemdUnit>();
  private readonly logsByUnit = new Map<string, SystemdLogLine[]>();

  seed(units: readonly SystemdUnit[]): void {
    units.forEach((u) => {
      if (!this.snapshots.has(u.name)) this.snapshots.set(u.name, { ...u });
    });
  }

  snapshot(name: string): SystemdUnit | null {
    const u = this.snapshots.get(name);
    return u ? { ...u } : null;
  }

  list(): SystemdUnit[] {
    return Array.from(this.snapshots.values())
      .map((u) => ({ ...u }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  pushLog(name: string, line: SystemdLogLine): void {
    const list = this.logsByUnit.get(name) ?? [];
    list.push(line);
    if (list.length > 500) list.splice(0, list.length - 500);
    this.logsByUnit.set(name, list);
  }

  logsFor(name: string): readonly SystemdLogLine[] {
    return this.logsByUnit.get(name) ?? [];
  }

  run = async (ctx: UnitExecutorContext): Promise<UnitExecutorResult> => {
    const current = this.snapshots.get(ctx.unit.name);
    if (!current) {
      return {
        stdout: "",
        stderr: `Unit ${ctx.unit.name} not loaded in mock executor`,
        exitCode: 1,
        unit: ctx.unit,
      };
    }
    const next = applyAction(current, ctx.action);
    this.snapshots.set(ctx.unit.name, next);
    return {
      stdout: `__cortexos_systemd_mock__ ${ctx.action} ${ctx.unit.name}`,
      stderr: "",
      exitCode: 0,
      unit: next,
    };
  };
}

// ---------------------------------------------------------------------------
// Seed data — representative set for the M2 mock.
// ---------------------------------------------------------------------------

const SEED_UNITS: readonly SystemdUnit[] = [
  {
    name: "caddy.service",
    description: "Caddy HTTP/2 web server",
    load: "loaded",
    active: "active",
    sub: "running",
    enabled: true,
    type: "service",
    unitPath: "/etc/systemd/system/caddy.service",
    allowlisted: true,
    critical: false,
  },
  {
    name: "tailscaled.service",
    description: "Tailscale node agent",
    load: "loaded",
    active: "active",
    sub: "running",
    enabled: true,
    type: "service",
    unitPath: "/usr/lib/systemd/system/tailscaled.service",
    allowlisted: true,
    critical: false,
  },
  {
    name: "postgresql.service",
    description: "PostgreSQL database server",
    load: "loaded",
    active: "active",
    sub: "running",
    enabled: true,
    type: "service",
    unitPath: "/usr/lib/systemd/system/postgresql.service",
    allowlisted: true,
    critical: true,
  },
  {
    name: "redis-server.service",
    description: "Advanced key-value store",
    load: "loaded",
    active: "inactive",
    sub: "dead",
    enabled: true,
    type: "service",
    unitPath: "/usr/lib/systemd/system/redis-server.service",
    allowlisted: true,
    critical: false,
  },
  {
    name: "nginx.service",
    description: "A high performance web server and a reverse proxy server",
    load: "loaded",
    active: "failed",
    sub: "failed",
    enabled: true,
    type: "service",
    unitPath: "/etc/systemd/system/nginx.service",
    allowlisted: true,
    critical: true,
  },
  {
    name: "docker.service",
    description: "Docker Application Container Engine",
    load: "loaded",
    active: "active",
    sub: "running",
    enabled: true,
    type: "service",
    unitPath: "/usr/lib/systemd/system/docker.service",
    allowlisted: true,
    critical: true,
  },
  {
    name: "unattended-upgrades.service",
    description: "Unattended Upgrades Shutdown",
    load: "loaded",
    active: "inactive",
    sub: "dead",
    enabled: false,
    type: "service",
    unitPath: "/usr/lib/systemd/system/unattended-upgrades.service",
    allowlisted: false,
    critical: false,
  },
  {
    name: "cron.service",
    description: "Regular background program processing daemon",
    load: "loaded",
    active: "active",
    sub: "running",
    enabled: true,
    type: "service",
    unitPath: "/usr/lib/systemd/system/cron.service",
    allowlisted: true,
    critical: false,
  },
];

const MANAGED_UNIT_METADATA: Readonly<
  Record<string, Pick<SystemdUnit, "allowlisted" | "critical">>
> = {
  "caddy.service": { allowlisted: true, critical: false },
  "tailscaled.service": { allowlisted: true, critical: false },
  "postgresql.service": { allowlisted: true, critical: true },
  "redis-server.service": { allowlisted: true, critical: false },
  "docker.service": { allowlisted: true, critical: true },
  "cron.service": { allowlisted: true, critical: false },
};

const MANAGED_UNIT_PATTERNS = [
  /^cortex-[a-z0-9@_.-]+\.service$/,
  /^durindoor(?:-[a-z0-9@_.-]+)?\.service$/,
  /^hermes-(?:dashboard(?:-proxy)?|(?:gateway|profile)@[a-z0-9_-]+)\.service$/,
] as const;

/** Resolve action authorization independently from live systemd enumeration. */
export function managedUnitMetadata(name: string): Pick<SystemdUnit, "allowlisted" | "critical"> {
  return (
    MANAGED_UNIT_METADATA[name] ?? {
      allowlisted: MANAGED_UNIT_PATTERNS.some((pattern) => pattern.test(name)),
      critical: false,
    }
  );
}

function seedLogs(mock: MockUnitExecutor): void {
  const now = new Date().toISOString();
  SEED_UNITS.forEach((u) => {
    mock.pushLog(u.name, {
      ts: now,
      priority: "info",
      unit: u.name,
      message: `Started ${u.name}.`,
    });
    mock.pushLog(u.name, {
      ts: now,
      priority: "info",
      unit: u.name,
      message: `Reached target ${u.description || u.name}.`,
    });
    if (u.active === "failed") {
      mock.pushLog(u.name, {
        ts: now,
        priority: "err",
        unit: u.name,
        message: `Main process exited, code=exited, status=1/FAILURE.`,
      });
    }
  });
}

function makeDefaultMock(): { mock: MockUnitExecutor; executor: UnitExecutor } {
  const mock = new MockUnitExecutor();
  mock.seed(SEED_UNITS);
  seedLogs(mock);
  return { mock, executor: (ctx) => mock.run(ctx) };
}

// ---------------------------------------------------------------------------
// Real executor (Linux only) — execFile with fixed argv, no shell.
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

/**
 * Parse `systemctl show` key=value output into a partial SystemdUnit.
 */
function parseSystemctlShow(out: string, fallback: SystemdUnit): SystemdUnit {
  const get = (k: string): string | undefined => {
    const m = new RegExp(`^${k}=(.*)$`, "m").exec(out);
    return m?.[1];
  };
  const active = (get("ActiveState") as SystemdActiveState) ?? fallback.active;
  const sub = get("SubState") ?? fallback.sub;
  const load = (get("LoadState") as SystemdLoadState) ?? fallback.load;
  const unitFileState = get("UnitFileState") ?? "";
  const enabled = unitFileState === "enabled" || unitFileState === "enabled-runtime";
  const type = get("Type") ?? fallback.type;
  const unitPath = get("FragmentPath") ?? null;
  const description = get("Description") ?? fallback.description;
  return {
    ...fallback,
    description,
    load,
    active,
    sub,
    enabled,
    type,
    unitPath: unitPath === "" ? null : unitPath,
  };
}

const realSystemdExecutor: UnitExecutor = async (ctx) => {
  // Fixed argv — no shell, no string interpolation (PB-2 / T-104).
  const args: string[] = [ctx.action, ctx.unit.name];
  try {
    const { stdout, stderr } = await execFileAsync("/usr/bin/systemctl", args, {
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    // Query real post-action state for the UI snapshot.
    const { stdout: showOut } = await execFileAsync(
      "/usr/bin/systemctl",
      [
        "show",
        ctx.unit.name,
        "--property=ActiveState,SubState,LoadState,UnitFileState,Type,FragmentPath,Description",
      ],
      { timeout: 10_000, maxBuffer: 256 * 1024 },
    );
    const updated = parseSystemctlShow(showOut, ctx.unit);
    return { stdout: stdout ?? "", stderr: stderr ?? "", exitCode: 0, unit: updated };
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string; message?: string };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? e.message ?? "systemctl exec failed",
      exitCode: typeof e.code === "number" ? e.code : 1,
      unit: ctx.unit,
    };
  }
};

/** Result of a privileged fixed-argv exec (never throws). */
export interface PrivilegedExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const PRIVILEGED_PROGRAMS = {
  systemctl: "/usr/bin/systemctl",
  docker: "/usr/bin/docker",
} as const;

/**
 * Narrow shared exec for privileged host commands — the SAME execFile
 * mechanism the real executor above uses (fixed argv array, no shell, no
 * string interpolation; PB-2 / T-104). Only the two pinned binaries may run,
 * so callers can never turn this into an arbitrary command runner. Failures
 * are reported via exitCode/stderr — this helper NEVER throws, so best-effort
 * callers (stats collection, toggles) degrade instead of 500-ing the page.
 */
export async function execPrivileged(
  program: keyof typeof PRIVILEGED_PROGRAMS,
  args: readonly string[],
  opts: { timeout?: number; maxBuffer?: number } = {},
): Promise<PrivilegedExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync(PRIVILEGED_PROGRAMS[program], [...args], {
      timeout: opts.timeout ?? 30_000,
      maxBuffer: opts.maxBuffer ?? 4 * 1024 * 1024,
    });
    return { stdout: stdout ?? "", stderr: stderr ?? "", exitCode: 0 };
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string; message?: string };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? e.message ?? `${program} exec failed`,
      exitCode: typeof e.code === "number" ? e.code : 1,
    };
  }
}

// ---------------------------------------------------------------------------
// Real listUnits / getUnit from live systemctl.
// ---------------------------------------------------------------------------

async function getUnitFromSystemctl(name: string): Promise<SystemdUnit | null> {
  try {
    const { stdout } = await execFileAsync(
      "/usr/bin/systemctl",
      [
        "show",
        name,
        "--property=Names,Description,LoadState,ActiveState,SubState,UnitFileState,Type,FragmentPath",
      ],
      { timeout: 5_000, maxBuffer: 64 * 1024 },
    );
    const props = stdout.split("\n").reduce<Record<string, string>>((acc, line) => {
      const m = /^(\w+)=(.*)$/.exec(line);
      if (m) acc[m[1]] = m[2]!;
      return acc;
    }, {});
    if (Object.keys(props).length <= 1) return null;
    const unitFileState = props.UnitFileState ?? "";
    return {
      name,
      description: props.Description ?? "",
      load: (props.LoadState as SystemdLoadState) ?? "loaded",
      active: (props.ActiveState as SystemdActiveState) ?? "unknown",
      sub: props.SubState ?? "",
      enabled: unitFileState === "enabled" || unitFileState === "enabled-runtime",
      type: props.Type ?? "service",
      unitPath: props.FragmentPath?.trim() || null,
      ...managedUnitMetadata(name),
    };
  } catch (err) {
    throw new Error("Systemd unit lookup unavailable", { cause: err });
  }
}

async function listUnitsFromSystemctl(): Promise<SystemdUnit[]> {
  try {
    const { stdout } = await execFileAsync(
      "/usr/bin/systemctl",
      ["list-units", "--type=service", "--all", "--no-pager", "--no-legend", "--plain"],
      { timeout: 5_000, maxBuffer: 256 * 1024 },
    );
    const names = stdout
      .split("\n")
      .map((line) => {
        const m = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)/.exec(line.trim());
        if (!m) return null;
        const [, name] = m;
        if (!name || !name.endsWith(".service")) return null;
        return name;
      })
      .filter((name): name is string => name !== null);
    const units = await Promise.all(names.map((name) => getUnitFromSystemctl(name)));
    return units
      .filter((unit): unit is SystemdUnit => unit !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    throw new Error("Systemd unit inventory unavailable", { cause: err });
  }
}

// ---------------------------------------------------------------------------
// Module-level state — executor is the only swappable piece.
// ---------------------------------------------------------------------------

let currentMock: MockUnitExecutor | null = null;
let executor: UnitExecutor = () => {
  throw new Error("systemd bridge: executor used before init");
};

(function init() {
  if (process.env.NODE_ENV !== "test") {
    if (process.env.CORTEX_SYSTEMD_BRIDGE_REAL === "0") {
      throw new Error("CORTEX_SYSTEMD_BRIDGE_REAL=0 is test-only; remove it to use systemd");
    }
    if (process.platform !== "linux") throw new Error("systemd bridge requires Linux");
  }
  const useReal = process.platform === "linux" && process.env.CORTEX_SYSTEMD_BRIDGE_REAL !== "0";
  if (useReal) {
    executor = realSystemdExecutor;
    return;
  }
  const { mock, executor: e } = makeDefaultMock();
  currentMock = mock;
  executor = e;
})();

/** Test helper: swap the executor. Pass `null` to reset to the default mock. */
export function setExecutorForTests(fn: UnitExecutor | null): void {
  if (process.env.NODE_ENV !== "test") throw new Error("systemd executor injection is test-only");
  if (fn) {
    executor = fn;
    return;
  }
  const { mock, executor: e } = makeDefaultMock();
  currentMock = mock;
  executor = e;
}

/** Test helper: peek at the underlying mock. */
export function getMockExecutorForTests(): MockUnitExecutor {
  if (process.env.NODE_ENV !== "test") throw new Error("systemd mock controls are test-only");
  if (!currentMock) {
    const { mock, executor: e } = makeDefaultMock();
    currentMock = mock;
    executor = e;
  }
  return currentMock;
}

/** Reset the in-memory store + re-seed with the default units. */
export function resetSystemdBridgeForTests(): void {
  if (process.env.NODE_ENV !== "test") throw new Error("systemd mock controls are test-only");
  const { mock, executor: e } = makeDefaultMock();
  currentMock = mock;
  executor = e;
}

/** The default seed — exposed so tests can assert against a known set. */
export { SEED_UNITS };

// ---------------------------------------------------------------------------
// Loaders — used by server functions.
// ---------------------------------------------------------------------------

/** List all units. Uses real systemctl on Linux; mock otherwise. */
export async function listUnits(): Promise<SystemdUnit[]> {
  if (!currentMock) {
    return listUnitsFromSystemctl();
  }
  return currentMock.list();
}

/** Look up a unit by name. Returns null when not found. */
export async function getUnit(name: string): Promise<SystemdUnit | null> {
  if (!currentMock) {
    return getUnitFromSystemctl(name);
  }
  return currentMock.snapshot(name);
}

/** Return the most-recent `limit` log lines for a unit. */
export async function listLogs(name: string, limit: number): Promise<SystemdLogLine[]> {
  if (currentMock) {
    const all = currentMock.logsFor(name);
    return [...all].slice(-Math.max(0, limit));
  }
  // Real journalctl path (Linux only).
  try {
    const { stdout } = await execFileAsync(
      "/usr/bin/journalctl",
      ["--unit", name, "-n", String(limit), "--no-pager", "--output=json"],
      { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
    );
    const lines: SystemdLogLine[] = [];
    stdout.split("\n").forEach((rawLine) => {
      const trimmed = rawLine.trim();
      if (!trimmed) return;
      try {
        const entry = JSON.parse(trimmed) as Record<string, unknown>;

        const rt = entry["__REALTIME_TIMESTAMP"];
        const ts = rt ? new Date(Number(rt) / 1000).toISOString() : new Date().toISOString();
        const priorityNum = Number(entry.PRIORITY ?? 6);
        const priorityMap: Record<number, SystemdLogLine["priority"]> = {
          0: "emerg",
          1: "alert",
          2: "crit",
          3: "err",
          4: "warning",
          5: "notice",
          6: "info",
          7: "debug",
        };
        const priority = priorityMap[priorityNum] ?? "info";
        lines.push({
          ts,
          priority,

          unit: String(entry["_SYSTEMD_UNIT"] ?? name),
          message: String(entry.MESSAGE ?? ""),
        });
      } catch {
        // skip malformed lines
      }
    });
    return lines;
  } catch (err) {
    throw new Error("Systemd unit logs unavailable", { cause: err });
  }
}

/**
 * Return the most-recent `limit` log lines for the WHOLE host journal
 * (no `--unit` filter, MP-009). Same line shape as `listLogs` (SystemdLogLine).
 * execFile fixed-argv; never invokes a shell.
 */
export async function listHostLogs(limit: number): Promise<SystemdLogLine[]> {
  if (currentMock) {
    // Mock: concatenate seeded per-unit logs (newest-last in the mock
    // store) so the dashboard has something to render. Same SystemdLogLine
    // shape; callers map to display text.
    const cap = Math.max(0, limit);
    const mock = currentMock;
    const merged = SEED_UNITS.reduce<SystemdLogLine[]>((acc, u) => {
      acc.push(...mock.logsFor(u.name));
      return acc;
    }, []);
    // newest last in the mock store → take the tail
    return merged.slice(-cap);
  }
  // Real journalctl path (Linux only). NO `--unit` filter — whole host.
  try {
    const { stdout } = await execFileAsync(
      "/usr/bin/journalctl",
      ["-n", String(limit), "--no-pager", "--output=json"],
      { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
    );
    const lines: SystemdLogLine[] = [];
    stdout.split("\n").forEach((rawLine) => {
      const trimmed = rawLine.trim();
      if (!trimmed) return;
      try {
        const entry = JSON.parse(trimmed) as Record<string, unknown>;

        const rt = entry["__REALTIME_TIMESTAMP"];
        const ts = rt ? new Date(Number(rt) / 1000).toISOString() : new Date().toISOString();
        const priorityNum = Number(entry.PRIORITY ?? 6);
        const priorityMap: Record<number, SystemdLogLine["priority"]> = {
          0: "emerg",
          1: "alert",
          2: "crit",
          3: "err",
          4: "warning",
          5: "notice",
          6: "info",
          7: "debug",
        };
        const priority = priorityMap[priorityNum] ?? "info";
        lines.push({
          ts,
          priority,

          unit: String(entry["_SYSTEMD_UNIT"] ?? "host"),
          message: String(entry.MESSAGE ?? ""),
        });
      } catch {
        // skip malformed lines
      }
    });
    return lines;
  } catch (err) {
    throw new Error("Systemd journal unavailable", { cause: err });
  }
}

// ---------------------------------------------------------------------------
// Dispatch — the privileged path. Always returns a DispatchResult.
// ---------------------------------------------------------------------------

export interface DispatchInput {
  action: SystemdActionKind;
  name: string;
}

export interface DispatchContext {
  user: User;
  ip: string;
  userAgent: string | null;
  requestId: string;
  sessionId: string;
  /** Approval token — required for destructive actions (restart, stop, disable). */
  approvalToken?: string;
}

export type DispatchResult =
  | {
      status: "accepted";
      action: SystemdActionKind;
      name: string;
      stdout: string;
      stderr: string;
      exitCode: number;
      unit: SystemdUnit;
      durationMs: number;
    }
  | {
      status: "approval_required";
      action: SystemdActionKind;
      name: string;
      actionHash: string;
      ttlSec: number;
      message: string;
    }
  | {
      status: "rejected";
      action: SystemdActionKind;
      name: string;
      code:
        | "unknown_unit"
        | "not_allowlisted"
        | "unit_name_invalid"
        | "approval_required"
        | "approval_invalid"
        | "approval_expired"
        | "approval_session_mismatch"
        | "approval_already_used"
        | "executor_error";
      reason: string;
    };

/** Actions that require an approval token (SR-120). */
const DESTRUCTIVE_ACTIONS: ReadonlySet<SystemdActionKind> = new Set<SystemdActionKind>([
  "restart",
  "stop",
  "disable",
]);

/** Strict unit-name regex — no shell metacharacters (SR-030, T-030). */
const UNIT_NAME_RE = /^[A-Za-z0-9_.@-]+$/;

const APPROVAL_TTL_SEC = 60;

function approvalRejectionCode(
  reason: string,
): "approval_expired" | "approval_already_used" | "approval_session_mismatch" | "approval_invalid" {
  if (reason === "expired") return "approval_expired";
  if (reason === "already_used") return "approval_already_used";
  if (reason === "session_mismatch") return "approval_session_mismatch";
  return "approval_invalid";
}

/**
 * Dispatch a systemd action. Checks:
 *   1. Unit name regex.
 *   2. Unit exists in the executor's snapshot and is allowlisted.
 *   3. Destructive actions require a valid approval token.
 *   4. Run the executor.
 */
export async function dispatchAction(
  input: DispatchInput,
  ctx: DispatchContext,
): Promise<DispatchResult> {
  const t0 = Date.now();
  const policyName = `systemd.${input.action}`;

  // 1. Unit name regex.
  if (!UNIT_NAME_RE.test(input.name)) {
    audit({
      actorUserId: ctx.user.id,
      actorSessionId: null,
      actorIp: ctx.ip,
      actorUserAgent: ctx.userAgent,
      surface: "systemd",
      action: "systemd.bridge.reject",
      target: input.name,
      result: "denied",
      errorCode: "unit_name_invalid",
      requestId: ctx.requestId,
      payload: { phase: "name_regex", op: policyName, name: input.name },
    });
    return {
      status: "rejected",
      action: input.action,
      name: input.name,
      code: "unit_name_invalid",
      reason: `unit name '${input.name}' does not match ${UNIT_NAME_RE.source}`,
    };
  }

  // 2. Unit lookup + allowlist check.
  const unit = await getUnit(input.name);
  if (!unit) {
    audit({
      actorUserId: ctx.user.id,
      actorSessionId: null,
      actorIp: ctx.ip,
      actorUserAgent: ctx.userAgent,
      surface: "systemd",
      action: "systemd.bridge.reject",
      target: input.name,
      result: "failure",
      errorCode: "unknown_unit",
      requestId: ctx.requestId,
      payload: { phase: "lookup", op: policyName, name: input.name },
    });
    return {
      status: "rejected",
      action: input.action,
      name: input.name,
      code: "unknown_unit",
      reason: `unit '${input.name}' is not in the executor's snapshot`,
    };
  }
  if (!unit.allowlisted) {
    audit({
      actorUserId: ctx.user.id,
      actorSessionId: null,
      actorIp: ctx.ip,
      actorUserAgent: ctx.userAgent,
      surface: "systemd",
      action: "systemd.bridge.reject",
      target: input.name,
      result: "denied",
      errorCode: "not_allowlisted",
      requestId: ctx.requestId,
      payload: { phase: "allowlist_unit", op: policyName, name: input.name },
    });
    return {
      status: "rejected",
      action: input.action,
      name: input.name,
      code: "not_allowlisted",
      reason: `unit '${input.name}' is not allowlisted`,
    };
  }

  // 3. Destructive action → approval gate.
  if (DESTRUCTIVE_ACTIONS.has(input.action)) {
    const actionHash = actionHashFor(policyName, { name: input.name });
    if (!ctx.approvalToken) {
      audit({
        actorUserId: ctx.user.id,
        actorSessionId: null,
        actorIp: ctx.ip,
        actorUserAgent: ctx.userAgent,
        surface: "systemd",
        action: "systemd.bridge.approval_required",
        target: input.name,
        result: "success",
        errorCode: null,
        requestId: ctx.requestId,
        payload: { phase: "approval_required", op: policyName, actionHash },
      });
      return {
        status: "approval_required",
        action: input.action,
        name: input.name,
        actionHash,
        ttlSec: APPROVAL_TTL_SEC,
        message: `Destructive systemd action '${input.action}' on '${input.name}' requires an approval token`,
      };
    }
    const v = consumeApproval(ctx.approvalToken, ctx.sessionId as SessionId);
    if (!v.ok) {
      const reason = `approval token ${v.reason}`;
      audit({
        actorUserId: ctx.user.id,
        actorSessionId: null,
        actorIp: ctx.ip,
        actorUserAgent: ctx.userAgent,
        surface: "systemd",
        action: "systemd.bridge.reject",
        target: input.name,
        result: "denied",
        errorCode: v.reason,
        requestId: ctx.requestId,
        payload: { phase: "approval_verify", op: policyName, reason: v.reason },
      });
      return {
        status: "rejected",
        action: input.action,
        name: input.name,
        code: approvalRejectionCode(v.reason),
        reason,
      };
    }
    if (v.claims.actionHash !== actionHash) {
      audit({
        actorUserId: ctx.user.id,
        actorSessionId: null,
        actorIp: ctx.ip,
        actorUserAgent: ctx.userAgent,
        surface: "systemd",
        action: "systemd.bridge.reject",
        target: input.name,
        result: "denied",
        errorCode: "approval_invalid",
        requestId: ctx.requestId,
        payload: {
          phase: "approval_action_mismatch",
          expected: actionHash,
          got: v.claims.actionHash,
        },
      });
      return {
        status: "rejected",
        action: input.action,
        name: input.name,
        code: "approval_invalid",
        reason: "approval token is not bound to this action + name",
      };
    }
  }

  // 4. Run the executor.
  try {
    const result = await executor({
      unit,
      action: input.action,
      user: ctx.user,
      ip: ctx.ip,
      requestId: ctx.requestId,
    });
    audit({
      actorUserId: ctx.user.id,
      actorSessionId: null,
      actorIp: ctx.ip,
      actorUserAgent: ctx.userAgent,
      surface: "systemd",
      action: "systemd.bridge.dispatch",
      target: input.name,
      result: "success",
      errorCode: null,
      requestId: ctx.requestId,
      payload: {
        op: policyName,
        exitCode: result.exitCode,
        stdoutBytes: result.stdout.length,
        stderrBytes: result.stderr.length,
      },
    });
    return {
      status: "accepted",
      action: input.action,
      name: input.name,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      unit: result.unit,
      durationMs: Date.now() - t0,
    };
  } catch (e) {
    audit({
      actorUserId: ctx.user.id,
      actorSessionId: null,
      actorIp: ctx.ip,
      actorUserAgent: ctx.userAgent,
      surface: "systemd",
      action: "systemd.bridge.dispatch",
      target: input.name,
      result: "failure",
      errorCode: "executor_error",
      requestId: ctx.requestId,
      payload: { op: policyName, error: (e as Error).message },
    });
    return {
      status: "rejected",
      action: input.action,
      name: input.name,
      code: "executor_error",
      reason: `executor error: ${(e as Error).message}`,
    };
  }
}

/**
 * Self-mint an approval token for non-destructive actions that still need
 * one to pass the gate. Exposed so the server functions can call this
 * without importing the approval module directly.
 */
export { mintApproval };
