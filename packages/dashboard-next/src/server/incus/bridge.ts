/**
 * Incus bridge — server-side dispatcher for Incus instance operations.
 *
 * Mirrors the role of `systemd/bridge.ts` and `terminal/pty-bridge.ts`:
 * a swappable `IncusExecutor` interface sits behind a strict policy
 * gate, every action is audit-logged, and the destructive subset
 * (`stop`, `restart`, `delete`) requires an approval token bound to
 * the (action, name) action-hash (PB-5).
 *
 * M2 ships a `MockIncusExecutor` — an in-memory `Map<name, IncusInstance>`
 * the executor mutates. The M3 swap is the real `incus` CLI (or unix
 * socket) with the same `(ctx) => Promise<IncusExecutorResult>` shape.
 *
 * Hard rules (THREAT_MODEL v0.3 + PB-4 + PB-5 + SR-019):
 *   - Every instance name is regex-validated AND check against the
 *     allowlist table (the instance's `allowlisted` flag from the
 *     mock).
 *   - Admin-gated: every `dispatch*` call requires `isAdmin(user)`.
 *   - Destructive actions (`stop`, `restart`, `delete`) require an
 *     approval token whose `actionHash` matches `actionHashFor(
 *     'incus.' + action, { name })` (PB-5).
 *   - PB-4: the exec-named route is a separate allowlist-driven
 *     path; the bridge re-runs the policy + arg-smuggling guards
 *     from `terminal/pty-bridge.ts` and never produces a
 *     `bash -c <userstring>` argv (SR-019).
 *
 * Public surface:
 *   - listInstances()                      → IncusInstance[]
 *   - getInstance(name)                    → IncusInstance | null
 *   - listInstanceLogs(name, limit)        → IncusLogLine[]
 *   - listInstanceActions()                → readonly AllowlistEntry[]
 *   - listImages()                         → IncusImage[]
 *   - runPreflightReport(config)           → IncusPreflightReport
 *   - dispatchAction(input, ctx)           → DispatchResult
 *   - dispatchExecNamed(input, ctx)        → ExecDispatchResult
 *   - setExecutorForTests(fn)              → test helper
 */
import {
  type IncusInstance,
  type IncusImage,
  type IncusShellOp,
  type IncusPreflightReport,
  type IncusPreflightCheck,
  type ProgressStep,
  type IncusInstanceConfig,
} from "@cortexos/contracts";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { closeSync, lstatSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dashboardPaths } from "@/server/paths";
import { type MockInstanceRecord, mapIncusImageType, mapIncusJsonToMockRecord } from "./incus-json";
import { audit } from "../audit";
import { actionHashFor } from "../approval";
import { allowlistedCommand, type AllowlistEntry } from "../policy";
import type { User } from "../entities";
import { asSessionId } from "../entities";

/**
 * Local log-line shape. The contracts package does not export an
 * `IncusLogLine` (Incus logs are not on the M2 contracts surface);
 * the bridge defines the wire shape and projects it to the UI.
 */
export interface IncusLogLine {
  ts: string;
  priority: "info" | "warn" | "error" | "debug";
  name: string;
  message: string;
}

const execFileAsync = promisify(execFile);

/**
 * Injectable exec seam for the REAL instance-log fetch. Defaults to running
 * the `incus` CLI via `execFile` (no shell, fixed argv). Tests swap it via
 * `setLogExecForTests` to assert the argv and feed canned stdout without a
 * real `incus` binary. Returns `{ stdout }` (stderr is ignored for logs).
 */
export type IncusLogExec = (argv: readonly string[]) => Promise<{ stdout: string }>;

const defaultLogExec: IncusLogExec = async (argv) => {
  const { stdout } = await execFileAsync("incus", argv as string[], {
    timeout: 15_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return { stdout: stdout ?? "" };
};

let logExec: IncusLogExec = defaultLogExec;

/** Strict regex for incus instance names. Mirrors the policy module. */
const INSTANCE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;

/** Test helper: swap the log-exec seam. Pass `null` to reset to the default. */
export function setLogExecForTests(fn: IncusLogExec | null): void {
  if (process.env.NODE_ENV !== "test") throw new Error("Incus log executor injection is test-only");
  logExec = fn ?? defaultLogExec;
}

// ---------------------------------------------------------------------------
// Executor interface — the seam between M2 (mock) and M3 (incus CLI).
// ---------------------------------------------------------------------------

/**
 * The argv-free context the executor sees. Mirrors the contracts
 * `IncusInstance` plus caller metadata. The executor is a pure
 * function of (instance, action, user) → side effect + result.
 */
export interface IncusExecutorContext {
  /** The instance the action targets. */
  instance: IncusInstance;
  /** The action being performed. */
  action: IncusActionKind;
  /** The user on whose behalf the action runs. */
  user: User;
  /** Client IP, recorded for the audit log. */
  ip: string;
  /** Request id, echoed in the audit row. */
  requestId: string;
}

/**
 * The result the executor returns. Mirrors `IncusActionResult` plus
 * a friendly message for the UI and the updated instance snapshot
 * (so the UI can re-render without a refetch).
 */
export interface IncusExecutorResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** The updated instance snapshot. */
  instance: IncusInstance;
}

/**
 * The swappable executor. M2 ships `MockIncusExecutor`; M3 will ship
 * `IncusCLIExecutor` that runs the real `incus` via the root helper.
 */
export type IncusExecutor = (ctx: IncusExecutorContext) => Promise<IncusExecutorResult>;

/**
 * Mirrors the `IncusActionKind` union from @cortexos/contracts,
 * re-declared so the Svelte components can exhaustively switch over
 * actions without resolving the Zod-inferred type.
 */
export type IncusActionKind =
  "start" | "stop" | "restart" | "delete" | "launch" | "list" | "exec-named";

// ---------------------------------------------------------------------------
// Mock executor (M2). In-memory, deterministic, no shell.
// ---------------------------------------------------------------------------

/** A single Incus log line. Mirrors the contracts shape. */
export interface IncusLogLineEntry {
  ts: string;
  priority: "info" | "warn" | "error" | "debug";
  name: string;
  message: string;
}

/**
 * Apply an Incus action to a mock record. Pure function: same input
 * → same output. The mock executor calls this to derive the next
 * state. The set of states mirrors the real `incus` lifecycle
 * (draft → validated → provisioning → active/failed).
 */
export function applyAction(rec: MockInstanceRecord, action: IncusActionKind): MockInstanceRecord {
  switch (action) {
    case "start":
      return { ...rec, status: "active" };
    case "stop":
      return { ...rec, status: "stopped" };
    case "restart":
      return { ...rec, status: "active" };
    case "delete":
      return { ...rec, status: "failed" };
    case "launch":
      return { ...rec, status: "provisioning" };
    case "list":
    case "exec-named":
      return { ...rec };
    default:
      return { ...rec };
  }
}

/** Project a MockInstanceRecord into the contracts IncusInstance shape. */
function projectMockRecord(rec: MockInstanceRecord): IncusInstance {
  return {
    name: rec.name,
    slug: rec.slug,
    status: rec.status,
    type: rec.type,
    image: rec.image,
    cpu: rec.cpu ?? null,
    memory: rec.memory ?? null,
    config: rec.config,
    devices: rec.devices,
    lastValidation: rec.lastValidation ?? null,
    createdBy: rec.createdBy,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
  };
}

/**
 * The M2 mock executor. Keeps an in-memory `Map<name, MockInstanceRecord>`
 * and mutates `status` on dispatch. The exec-named executor is a
 * separate in-process helper (`MockExecNamedExecutor`) that uses
 * the same `Map`.
 */
export class MockIncusExecutor {
  private readonly snapshots = new Map<string, MockInstanceRecord>();

  /** Seed initial instances. Idempotent. */
  seed(instances: readonly MockInstanceRecord[]): void {
    instances.forEach((inst) => {
      if (!this.snapshots.has(inst.name)) {
        this.snapshots.set(inst.name, { ...inst });
      }
    });
  }

  /** Read-only snapshot. */
  snapshot(name: string): MockInstanceRecord | null {
    const inst = this.snapshots.get(name);
    return inst ? { ...inst } : null;
  }

  list(): IncusInstance[] {
    return Array.from(this.snapshots.values())
      .map((inst) => this.toContractsInstance(inst))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Push a fake log line (used by the mock for `listInstanceLogs`). */
  pushLog(name: string, line: IncusLogLineEntry): void {
    const list = this.logsByInstance.get(name) ?? [];
    list.push(line);
    if (list.length > 500) list.splice(0, list.length - 500);
    this.logsByInstance.set(name, list);
  }

  private readonly logsByInstance = new Map<string, IncusLogLineEntry[]>();

  /** Read the log buffer for an instance. */
  logsFor(name: string): readonly IncusLogLineEntry[] {
    return this.logsByInstance.get(name) ?? [];
  }

  /** Run an action — same shape as the `IncusExecutor` function. */
  run = async (ctx: IncusExecutorContext): Promise<IncusExecutorResult> => {
    const current = this.snapshots.get(ctx.instance.name);
    if (!current) {
      return {
        stdout: "",
        stderr: `Instance ${ctx.instance.name} not loaded in mock executor`,
        exitCode: 1,
        instance: ctx.instance,
      };
    }
    const next = applyAction(current, ctx.action);
    this.snapshots.set(ctx.instance.name, next);
    return {
      stdout: `__cortexos_incus_mock__ ${ctx.action} ${ctx.instance.name}`,
      stderr: "",
      exitCode: 0,
      instance: this.toContractsInstance(next),
    };
  };

  /** Project the mock record into the contracts shape the UI sees. */
  private toContractsInstance(rec: MockInstanceRecord): IncusInstance {
    return projectMockRecord(rec);
  }
}

// ---------------------------------------------------------------------------
// Real data loaders — called when currentMock is null (Linux production).
// ---------------------------------------------------------------------------

// The UI's stable identifier is the instance name. Refuse ambiguous names
// rather than route a destructive operation into the wrong project.
async function loadInstanceRows(exec: IncusLogExec = defaultLogExec): Promise<Record<string, unknown>[]> {
  const { stdout } = await exec(["list", "--all-projects", "--format", "json"]);
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) throw new Error("Invalid Incus instance inventory");
  const rows = parsed.filter((row): row is Record<string, unknown> =>
    typeof row === "object" && row !== null);
  const names = new Set<string>();
  for (const row of rows) {
    const name = String(row.name ?? "");
    if (names.has(name)) throw new Error(`Ambiguous Incus instance name "${name}" across projects`);
    names.add(name);
  }
  return rows;
}

async function resolveInstanceProject(name: string, exec: IncusLogExec = defaultLogExec): Promise<string> {
  const rows = await loadInstanceRows(exec);
  const row = rows.find((item) => item.name === name);
  if (!row) throw new Error(`Incus instance "${name}" is unavailable`);
  const project = row.project ?? "default";
  if (typeof project !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(project)) {
    throw new Error("Invalid Incus project identity");
  }
  return project;
}

/** List instances from the real incus CLI. */
async function listInstancesFromIncus(): Promise<IncusInstance[]> {
  try {
    const parsed = await loadInstanceRows();
    const records = parsed
      .filter((i): i is Record<string, unknown> => typeof i === "object" && i !== null)
      .map(mapIncusJsonToMockRecord);
    return records
      .map((rec) => projectMockRecord(rec))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    throw new Error("Incus instance inventory unavailable", { cause: err });
  }
}

/** Look up a single instance from the real incus CLI. */
async function getInstanceFromIncus(name: string): Promise<IncusInstance | null> {
  try {
    const parsed = await loadInstanceRows();
    const item = parsed.find(
      (i): i is Record<string, unknown> =>
        typeof i === "object" && i !== null && String((i).name) === name,
    );
    if (!item) return null;
    return projectMockRecord(mapIncusJsonToMockRecord(item));
  } catch (err) {
    throw new Error("Incus instance lookup unavailable", { cause: err });
  }
}

/** Look up a single instance as MockInstanceRecord (for dispatch). */
async function getMockRecordFromIncus(name: string): Promise<MockInstanceRecord | null> {
  try {
    const parsed = await loadInstanceRows();
    const item = parsed.find(
      (i): i is Record<string, unknown> =>
        typeof i === "object" && i !== null && String((i).name) === name,
    );
    if (!item) return null;
    return mapIncusJsonToMockRecord(item);
  } catch (err) {
    throw new Error("Incus instance lookup unavailable", { cause: err });
  }
}

/** List images from the real incus CLI. */
async function listImagesFromIncus(): Promise<IncusImage[]> {
  try {
    const { stdout } = await execFileAsync("incus", ["image", "list", "--format", "json"], {
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as unknown[];
    return parsed
      .filter((i): i is Record<string, unknown> => typeof i === "object" && i !== null)
      .map((item): IncusImage => {
        const aliases = Array.isArray(item.aliases)
          ? (item.aliases as Record<string, unknown>[])
              .map((a) => String(a.name ?? ""))
              .filter((n) => n.length > 0)
          : [];
        const props = (item.properties as Record<string, string>) ?? {};
        return {
          fingerprint: String(item.fingerprint ?? ""),
          architecture: String(item.architecture ?? ""),
          type: mapIncusImageType(String(item.type ?? "unknown")),
          size: typeof item.size === "number" ? item.size : 0,
          uploadedAt: String(item.uploaded_at ?? item.created_at ?? new Date().toISOString()),
          aliases,
          description: props.description ?? null,
        };
      })
      .sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
  } catch (err) {
    throw new Error("Incus image inventory unavailable", { cause: err });
  }
}

// ---------------------------------------------------------------------------
// Seed instances — representative set for the M2 mock.
// ---------------------------------------------------------------------------

const SEED_INSTANCES_INTERNAL: readonly MockInstanceRecord[] = [
  {
    name: "hermes-canary",
    slug: "hermes-canary",
    status: "active",
    type: "container",
    image: "ubuntu/24.04",
    cpu: 2,
    memory: 4096,
    config: {
      target: { mode: "new", branch: "main", ghOrg: "example-org", slug: "hermes-canary" },
      image: { alias: "ubuntu/24.04", gastown: false, profiles: ["default"], pool: "default" },
      hermes: { enabled: true, profile: "hermes", port: 18695, model: "gpt-4o-mini", proxies: [] },
      network: { bridge: "incusbr0", tailscale: true, webAccess: false },
    },
    devices: {
      root: { path: "/", pool: "default", type: "disk" },
      eth0: { name: "eth0", nictype: "bridged", parent: "incusbr0", type: "nic" },
    },
    lastValidation: {
      ok: true,
      ranAt: "2026-05-12T10:00:00.000Z",
      notes: "preflight passed",
    },
    createdBy: "00000000-0000-4000-8000-000000000001",
    createdAt: "2026-05-01T08:00:00.000Z",
    updatedAt: "2026-05-12T10:00:00.000Z",
    allowlisted: true,
    live: {
      status: "RUNNING",
      statusCode: "running",
      architecture: "x86_64",
      state: {
        networks: {
          eth0: {
            addresses: [{ family: "inet", address: "10.0.0.42", scope: "global" }],
            state: "up",
            type: "broadcast",
          },
        },
        pid: 12345,
      },
      profiles: ["default"],
      snapshots: [{ name: "pre-upgrade", createdAt: "2026-05-10T12:00:00.000Z", stateful: false }],
    },
  },
  {
    name: "archive-cold",
    slug: "archive-cold",
    status: "failed",
    type: "container",
    image: "alpine/3.20",
    cpu: 1,
    memory: 1024,
    config: {
      target: { mode: "new", branch: "main", ghOrg: "example-org", slug: "archive-cold" },
      image: { alias: "alpine/3.20", gastown: false, profiles: ["default"], pool: "hdd" },
      hermes: { enabled: false, proxies: [] },
      network: { bridge: "incusbr0", tailscale: false, webAccess: false },
    },
    devices: {
      root: { path: "/", pool: "hdd", type: "disk" },
    },
    lastValidation: {
      ok: false,
      ranAt: "2026-05-18T03:00:00.000Z",
      notes: "preflight failed: image alias not found",
    },
    createdBy: "00000000-0000-4000-8000-000000000003",
    createdAt: "2026-04-20T09:00:00.000Z",
    updatedAt: "2026-05-18T03:00:00.000Z",
    allowlisted: true,
    live: {
      status: "ERROR",
      statusCode: "error",
      architecture: "x86_64",
      state: { networks: {} },
      profiles: ["default"],
      snapshots: [],
    },
  },
  {
    name: "cortex-graph-dev",
    slug: "cortex-graph-dev",
    status: "draft",
    type: "container",
    image: "ubuntu/24.04",
    cpu: 2,
    memory: 2048,
    config: {
      target: { mode: "clone", branch: "main", ghOrg: "example-org", slug: "cortex-graph-dev" },
      image: { alias: "ubuntu/24.04", gastown: false, profiles: ["default"], pool: "default" },
      hermes: { enabled: false, proxies: [] },
      network: { bridge: "incusbr0", tailscale: true, webAccess: false },
    },
    devices: {},
    lastValidation: null,
    createdBy: "00000000-0000-4000-8000-000000000004",
    createdAt: "2026-05-22T11:00:00.000Z",
    updatedAt: "2026-05-22T11:00:00.000Z",
    allowlisted: true,
  },
];

/** Pre-populate the log buffer so the detail page is non-empty. */
function seedLogs(mock: MockIncusExecutor): void {
  const now = "2026-05-12T10:00:00.000Z";
  SEED_INSTANCES_INTERNAL.forEach((inst) => {
    mock.pushLog(inst.name, {
      ts: now,
      priority: "info",
      name: inst.name,
      message: `Instance ${inst.name} started`,
    });
    mock.pushLog(inst.name, {
      ts: now,
      priority: "info",
      name: inst.name,
      message: `Image ${inst.image} attached`,
    });
    if (inst.status === "failed" || inst.status === "error") {
      mock.pushLog(inst.name, {
        ts: "2026-05-18T03:00:00.000Z",
        priority: "error",
        name: inst.name,
        message: `Provisioning failed: image alias not found`,
      });
    }
    if (inst.status === "provisioning") {
      mock.pushLog(inst.name, {
        ts: "2026-05-15T14:30:05.000Z",
        priority: "info",
        name: inst.name,
        message: `Downloading image: ${inst.image}`,
      });
      mock.pushLog(inst.name, {
        ts: "2026-05-15T14:30:10.000Z",
        priority: "info",
        name: inst.name,
        message: `Image unpacked; unpacking rootfs`,
      });
    }
  });
}

/** Build a fresh default mock + wrapper. */
function makeDefaultMock(): { mock: MockIncusExecutor; executor: IncusExecutor } {
  const mock = new MockIncusExecutor();
  mock.seed(SEED_INSTANCES_INTERNAL);
  seedLogs(mock);
  return { mock, executor: (ctx) => mock.run(ctx) };
}

// ---------------------------------------------------------------------------
// Module-level state — the executor is the only swappable piece.
// ---------------------------------------------------------------------------

let currentMock: MockIncusExecutor | null = null;
let executor: IncusExecutor = (_p) => {
  throw new Error("incus bridge: executor used before init");
};

/** Test helper: swap the executor. Pass `null` to reset to the default mock. */
export function setExecutorForTests(fn: IncusExecutor | null): void {
  if (process.env.NODE_ENV !== "test") throw new Error("Incus executor injection is test-only");
  if (fn) {
    executor = fn;
    return;
  }
  const { mock, executor: e } = makeDefaultMock();
  currentMock = mock;
  executor = e;
}

/**
 * Test helper: disable the mock so loaders take the REAL (incus CLI) path.
 * Used together with `setLogExecForTests` to exercise the real log fetch
 * without a live `incus` binary. `resetIncusBridgeForTests()` re-enables it.
 */
export function disableMockForTests(): void {
  if (process.env.NODE_ENV !== "test") throw new Error("Incus mock controls are test-only");
  currentMock = null;
}

/** Test helper: peek at the underlying mock. */
export function getMockExecutorForTests(): MockIncusExecutor {
  if (process.env.NODE_ENV !== "test") throw new Error("Incus mock controls are test-only");
  if (!currentMock) {
    const { mock, executor: e } = makeDefaultMock();
    currentMock = mock;
    executor = e;
  }
  return currentMock;
}

/** Reset the in-memory store + re-seed with the default instances. */
export function resetIncusBridgeForTests(): void {
  if (process.env.NODE_ENV !== "test") throw new Error("Incus mock controls are test-only");
  const { mock, executor: e } = makeDefaultMock();
  currentMock = mock;
  executor = e;
}

// ---------------------------------------------------------------------------
// Loaders — used by the +page.server.ts and +server.ts handlers.
// ---------------------------------------------------------------------------

/** List all instances. M2: seeded + mutated snapshot. */
export async function listInstances(): Promise<IncusInstance[]> {
  if (currentMock) return currentMock.list();
  return listInstancesFromIncus();
}

/** Look up an instance by name. Returns null when not found. */
export async function getInstance(name: string): Promise<IncusInstance | null> {
  if (currentMock) {
    const rec = currentMock.snapshot(name);
    if (!rec) return null;
    return projectMockRecord(rec);
  }
  return getInstanceFromIncus(name);
}

/** Return the mock record (with allowlisted + live) for use by the bridge. */
export async function getMockRecord(name: string): Promise<MockInstanceRecord | null> {
  if (currentMock) return currentMock.snapshot(name);
  return getMockRecordFromIncus(name);
}

/**
 * Infer a log priority from a raw console line. Incus' `--show-log` is the
 * instance console buffer (free text, no structured level), so we do a cheap
 * keyword scan. Defaults to `info`.
 */
function inferLogPriority(line: string): IncusLogLine["priority"] {
  const l = line.toLowerCase();
  if (/\b(error|err|fail(ed|ure)?|fatal|panic)\b/.test(l)) return "error";
  if (/\b(warn(ing)?)\b/.test(l)) return "warn";
  if (/\b(debug|trace)\b/.test(l)) return "debug";
  return "info";
}

/**
 * Parse raw `incus console --show-log` stdout into log lines (oldest-first).
 * The console buffer is unstructured text; each non-empty line becomes one
 * entry with an inferred priority and the instance name. `ts` is left empty
 * (the console buffer carries no reliable per-line timestamp).
 */
function parseConsoleLog(name: string, stdout: string): IncusLogLine[] {
  return stdout
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l.trim().length > 0)
    .map((message) => ({
      ts: "",
      priority: inferLogPriority(message),
      name,
      message,
    }));
}

/** Return the most-recent `limit` log lines for an instance, newest first. */
export async function listInstanceLogs(name: string, limit: number): Promise<IncusLogLine[]> {
  if (currentMock) {
    const all = currentMock.logsFor(name);
    // The mock stores oldest-first; the API returns newest-first.
    const reversed = all.slice().reverse();
    return reversed.slice(0, Math.max(0, limit)).map((l) => ({
      ts: l.ts,
      priority: l.priority,
      name: l.name,
      message: l.message,
    }));
  }
  // Real path: fetch the instance console buffer via the incus CLI. The name
  // is validated to the strict instance-name regex first (defence-in-depth;
  // the argv is fixed and passed via execFile, so no shell injection is
  // possible regardless), then parsed into log lines.
  if (!INSTANCE_NAME_RE.test(name)) {
    throw new Error("Invalid Incus instance name");
  }
  try {
    const project = await resolveInstanceProject(name, logExec);
    const { stdout } = await logExec(["console", name, "--project", project, "--show-log"]);
    const parsed = parseConsoleLog(name, stdout);
    // Console buffer is oldest-first; the API returns newest-first.
    const reversed = parsed.slice().reverse();
    return reversed.slice(0, Math.max(0, limit));
  } catch (err) {
    throw new Error("Incus console logs unavailable", { cause: err });
  }
}

/**
 * List the Incus images known to the host. The M2 mock seeds three
 * representative images; M3 swaps to `incus image list --format json`.
 */
export async function listImages(): Promise<IncusImage[]> {
  if (currentMock) {
    return [
      {
        fingerprint: "aabbccddeeff00112233445566778899aabbccdd",
        architecture: "x86_64",
        type: "container",
        size: 512_000_000,
        uploadedAt: "2026-04-01T00:00:00.000Z",
        aliases: ["ubuntu/24.04", "ubuntu-lts"],
        description: "Ubuntu 24.04 LTS noble",
      },
      {
        fingerprint: "00112233445566778899aabbccddeeff00112233",
        architecture: "x86_64",
        type: "virtual-machine",
        size: 2_000_000_000,
        uploadedAt: "2026-03-15T00:00:00.000Z",
        aliases: ["debian/12", "debian-bookworm"],
        description: "Debian 12 bookworm",
      },
      {
        fingerprint: "fedcba9876543210fedcba9876543210fedcba98",
        architecture: "x86_64",
        type: "container",
        size: 24_000_000,
        uploadedAt: "2026-02-10T00:00:00.000Z",
        aliases: ["alpine/3.20"],
        description: "Alpine 3.20",
      },
    ];
  }
  return listImagesFromIncus();
}

// ---------------------------------------------------------------------------
// Real executor (Linux only). Calls `incus` via execFile — no shell,
// no string interpolation. The instance name is already validated by
// the bridge before this runs.
// ---------------------------------------------------------------------------

/**
 * Run `incus launch` and resolve on the process EXIT event rather than waiting
 * for stdio pipe EOF. `incus launch` exits in ~8s, but something in the launch
 * path keeps the captured stdout/stderr pipe open well past exit, so the usual
 * execFile (which resolves on pipe close) hangs until its timeout and then
 * SIGTERMs incus mid-create — rolling the new container back. Capturing stderr
 * to a temp file (no pipe to hold open) and resolving on `exit` avoids the hang.
 */
async function runIncusLaunch(
  argv: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const dir = mkdtempSync(join(tmpdir(), "incus-launch-"));
  const errPath = join(dir, "stderr");
  const errFd = openSync(errPath, "w");
  try {
    return await new Promise((resolve) => {
      const child = spawn("incus", argv, { stdio: ["ignore", "ignore", errFd] });
      const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
      child.on("exit", (code, signal) => {
        clearTimeout(timer);
        closeSync(errFd);
        const stderr = readFileSync(errPath, "utf8");
        resolve({
          stdout: "",
          stderr,
          exitCode: code ?? (signal ? 124 : 1),
        });
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        closeSync(errFd);
        resolve({ stdout: "", stderr: e.message, exitCode: 1 });
      });
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const realIncusExecutor: IncusExecutor = async (ctx) => {
  // `launch` carries the requested CPU/memory limits as repeated `-c` flags.
  // These are fixed-shape argv (no shell): `incus launch <image> <name>
  // [-c limits.cpu=<n>] [-c limits.memory=<n>MiB]`. cpu/memory are bounded
  // integers validated by dispatchAction before this runs.
  const launchArgs = ["launch", ctx.instance.image, ctx.instance.name];
  if (ctx.instance.cpu != null) {
    launchArgs.push("-c", `limits.cpu=${ctx.instance.cpu}`);
  }
  if (ctx.instance.memory != null) {
    launchArgs.push("-c", `limits.memory=${ctx.instance.memory}MiB`);
  }

  const args: Record<IncusActionKind, string[]> = {
    start: ["start", ctx.instance.name],
    stop: ["stop", ctx.instance.name],
    restart: ["restart", ctx.instance.name],
    delete: ["delete", ctx.instance.name, "--force"],
    launch: launchArgs,
    list: ["list", ctx.instance.name, "--format", "json"],
    "exec-named": ["list", ctx.instance.name, "--format", "json"],
  };

  try {
    if (ctx.action !== "launch") {
      args[ctx.action].push("--project", await resolveInstanceProject(ctx.instance.name));
    } else {
      args.launch.push("--project", "default");
    }
    // `launch` boots a container and needs the exit-event path (see
    // runIncusLaunch); start/stop/restart act on an existing instance and
    // return promptly under the normal pipe-capturing executor.
    if (ctx.action === "launch") {
      const res = await runIncusLaunch(args.launch, 120_000);
      if (res.exitCode !== 0) {
        return {
          stdout: res.stdout,
          stderr: res.stderr,
          exitCode: res.exitCode,
          instance: ctx.instance,
        };
      }
      const updated = await getMockRecord(ctx.instance.name);
      return {
        stdout: res.stdout,
        stderr: res.stderr,
        exitCode: 0,
        instance: updated ? projectMockRecord(updated) : ctx.instance,
      };
    }
    const { stdout, stderr } = await execFileAsync("incus", args[ctx.action], {
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const updated = await getMockRecord(ctx.instance.name);
    return {
      stdout: stdout ?? "",
      stderr: stderr ?? "",
      exitCode: 0,
      instance: updated ? projectMockRecord(updated) : ctx.instance,
    };
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string; message?: string };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? e.message ?? "incus exec failed",
      exitCode: typeof e.code === "number" ? e.code : 1,
      instance: ctx.instance,
    };
  }
};

(function init() {
  if (process.env.NODE_ENV !== "test") {
    if (process.env.CORTEX_INCUS_BRIDGE_REAL === "0") {
      throw new Error("CORTEX_INCUS_BRIDGE_REAL=0 is test-only; remove it to use Incus");
    }
    if (process.platform !== "linux") throw new Error("Incus bridge requires Linux");
  }
  const useReal = process.platform === "linux" && process.env.CORTEX_INCUS_BRIDGE_REAL !== "0";
  if (useReal) {
    executor = realIncusExecutor;
    return;
  }
  const { mock, executor: e } = makeDefaultMock();
  currentMock = mock;
  executor = e;
})();

// ---------------------------------------------------------------------------
// Preflight (M2 deterministic stub)
// ---------------------------------------------------------------------------

/**
 * M2 deterministic preflight — checks the (config) shape and the
 * mock state. Returns an `IncusPreflightReport`. M3 swaps to the
 * real `incus list` / image / network / pool queries.
 */
export async function runPreflightReport(
  config: IncusInstanceConfig,
): Promise<IncusPreflightReport> {
  const checks: IncusPreflightCheck[] = [];
  const name = config.target.slug;

  // 1. Name availability.
  const existingInstances = currentMock ? SEED_INSTANCES_INTERNAL : await listInstances();
  const knownNames = new Set(existingInstances.map((i) => i.name));
  checks.push({
    id: "name",
    label: "Instance name available",
    pass: !knownNames.has(name),
    detail: knownNames.has(name) ? `instance "${name}" already exists` : undefined,
  });

  // 2. Image.
  const existingImages = currentMock ? [] : await listImages();
  const knownAliases = currentMock
    ? new Set(["ubuntu/24.04", "debian/12", "alpine/3.20"])
    : new Set(existingImages.flatMap((i) => i.aliases));
  checks.push({
    id: "image",
    label: "Base image present",
    pass: knownAliases.has(config.image.alias),
    detail: knownAliases.has(config.image.alias)
      ? undefined
      : `no local image alias "${config.image.alias}"`,
  });

  // 3. Storage pool.
  let pools: string[] = ["default", "nvme", "hdd"];
  let bridges: string[] = ["incusbr0"];
  if (!currentMock) {
    const resources = await Promise.all(["storage", "network"].map(async (kind) => {
      const { stdout } = await execFileAsync("incus", [kind, "list", "--format", "json"], {
        timeout: 15_000, maxBuffer: 4 * 1024 * 1024,
      });
      const rows: unknown = JSON.parse(stdout);
      if (!Array.isArray(rows)) throw new Error(`Invalid Incus ${kind} inventory`);
      return rows.map((row: unknown) => {
        if (!row || typeof row !== "object" || !("name" in row) || typeof row.name !== "string") {
          throw new Error(`Invalid Incus ${kind} record`);
        }
        return row.name;
      });
    }));
    [pools, bridges] = resources;
  }
  const knownPools = new Set(pools);
  const pool = config.image.pool ?? "";
  checks.push({
    id: "pool",
    label: "Storage pool present",
    pass: knownPools.has(pool),
    detail: knownPools.has(pool) ? undefined : `storage pool "${pool}" not found`,
  });

  // 4. Network bridge.
  const knownBridges = new Set(bridges);
  checks.push({
    id: "bridge",
    label: "Network bridge present",
    pass: knownBridges.has(config.network.bridge),
    detail: knownBridges.has(config.network.bridge)
      ? undefined
      : `network bridge "${config.network.bridge}" not found`,
  });

  // 5. Hermes secret.
  if (config.hermes.enabled) {
    const validProfile = typeof config.hermes.profile === "string" &&
      /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(config.hermes.profile);
    const secret = join(dashboardPaths().secrets, `agent-${config.hermes.profile}-runtime.env`);
    const present = Boolean(currentMock) || (validProfile &&
      Boolean(lstatSync(secret, { throwIfNoEntry: false })?.isFile()));
    checks.push({
      id: "hermes-secret",
      label: "Hermes secret file present",
      pass: present,
      detail: present ? undefined : "Configured Hermes runtime secret file is missing",
    });
  }

  return {
    ok: checks.every((c) => c.pass),
    checks,
  };
}

// ---------------------------------------------------------------------------
// Provisioning progress
// ---------------------------------------------------------------------------

/**
 * Build a deterministic sequence of `ProgressStep`s for a fresh
 * instance launch.
 */
export function buildLaunchProgress(name: string): readonly ProgressStep[] {
  return [
    { step: "preflight", status: "pending", detail: `Validating ${name}…` },
    { step: "image-pull", status: "pending", detail: "Pulling base image" },
    { step: "image-unpack", status: "pending", detail: "Unpacking rootfs" },
    { step: "launch", status: "pending", detail: `Launching ${name}` },
    { step: "limits-apply", status: "pending", detail: "Applying CPU + memory limits" },
    { step: "network-attach", status: "pending", detail: "Attaching to bridge" },
    { step: "start", status: "pending", detail: "Starting instance" },
  ];
}

// ---------------------------------------------------------------------------
// Dispatch — the privileged path. Always returns a `DispatchResult`.
// ---------------------------------------------------------------------------

export interface DispatchInput {
  action: IncusActionKind;
  name: string;
  /** For `delete`: the typed-phrase the user confirmed. */
  confirmation?: string;
  /** For `launch`: the image alias (validated against the image allowlist). */
  image?: string;
  /** For `launch`: CPU core limit (defaults to 2; bounded 1..64). */
  cpu?: number;
  /** For `launch`: memory limit in MiB (defaults to 4096; bounded 128..262144). */
  memory?: number;
}

export interface DispatchContext {
  user: User;
  ip: string;
  userAgent: string | null;
  requestId: string;
  /**
   * Session id of the caller. Used to verify the approval token's
   * session binding (PB-1 / SR-020). Required for destructive actions.
   */
  sessionId: string;
  /** Optional approval token. Required for destructive actions. */
  approvalToken?: string;
}

/**
 * The structured result the bridge returns. Never throws — the route
 * handler converts `rejected` to the right HTTP status.
 */
export type DispatchResult =
  | {
      status: "accepted";
      action: IncusActionKind;
      name: string;
      stdout: string;
      stderr: string;
      exitCode: number;
      instance: IncusInstance;
      durationMs: number;
    }
  | {
      status: "approval_required";
      action: IncusActionKind;
      name: string;
      actionHash: string;
      ttlSec: number;
      message: string;
    }
  | {
      status: "rejected";
      action: IncusActionKind;
      name: string;
      code:
        | "unknown_op"
        | "unknown_instance"
        | "not_allowlisted"
        | "instance_name_invalid"
        | "instance_exists"
        | "image_invalid"
        | "confirmation_required"
        | "approval_required"
        | "approval_invalid"
        | "approval_expired"
        | "approval_session_mismatch"
        | "approval_already_used"
        | "executor_error";
      reason: string;
    };

/** The set of actions that the policy allowlist marks as destructive. */
const DESTRUCTIVE_ACTIONS_INTERNAL: ReadonlySet<IncusActionKind> = new Set<IncusActionKind>([
  "stop",
  "restart",
  "delete",
]);

/** TTL for a destructive-action approval token. */
const APPROVAL_TTL_SEC = 60;

/** Confirmation phrase required to delete an instance. */
export const DELETE_CONFIRMATION_PHRASE = "delete";

/**
 * Dispatch an Incus action.
 *
 * Order of checks (defence in depth — every layer rejects the bad case):
 *   1. Op is on the policy allowlist (e.g. `incus.restart`).
 *   2. Instance name matches the strict regex.
 *   3. Instance is in the executor's snapshot and is `allowlisted`.
 *   4. If the action is destructive, the caller must supply a valid
 *      approval token, which is consumed (single-use) before execution.
 *   5. If the action is `delete`, the caller must supply a typed
 *      confirmation phrase (PB-5 UX guard).
 *   6. Run the executor.
 */
function approvalRejectionCode(
  reason: string,
): "approval_expired" | "approval_already_used" | "approval_session_mismatch" | "approval_invalid" {
  if (reason === "expired") return "approval_expired";
  if (reason === "already_used") return "approval_already_used";
  if (reason === "session_mismatch") return "approval_session_mismatch";
  return "approval_invalid";
}

export async function dispatchAction(
  input: DispatchInput,
  ctx: DispatchContext,
): Promise<DispatchResult> {
  const t0 = Date.now();
  const policyName = `incus.${input.action}`;

  // 1. Policy allowlist.
  const entry: AllowlistEntry | undefined = allowlistedCommand(policyName);
  if (!entry) {
    audit({
      actorUserId: ctx.user.id,
      actorSessionId: null,
      actorIp: ctx.ip,
      actorUserAgent: ctx.userAgent,
      surface: "incus",
      action: "incus.bridge.reject",
      target: input.name,
      result: "failure",
      errorCode: "unknown_op",
      requestId: ctx.requestId,
      payload: { phase: "allowlist", op: policyName },
    });
    return {
      status: "rejected",
      action: input.action,
      name: input.name,
      code: "unknown_op",
      reason: `op '${policyName}' is not on the policy allowlist`,
    };
  }

  // 2. Instance name regex.
  if (!INSTANCE_NAME_RE.test(input.name)) {
    audit({
      actorUserId: ctx.user.id,
      actorSessionId: null,
      actorIp: ctx.ip,
      actorUserAgent: ctx.userAgent,
      surface: "incus",
      action: "incus.bridge.reject",
      target: input.name,
      result: "denied",
      errorCode: "instance_name_invalid",
      requestId: ctx.requestId,
      payload: { phase: "name_regex", op: policyName, name: input.name },
    });
    return {
      status: "rejected",
      action: input.action,
      name: input.name,
      code: "instance_name_invalid",
      reason: `instance name '${input.name}' does not match ${INSTANCE_NAME_RE.source}`,
    };
  }

  // 2b. Launch — dedicated provisioning branch.
  //
  // Unlike the lifecycle actions (start/stop/restart/delete), `launch`
  // CREATES a brand-new instance, so there is no existing record to look
  // up. It runs its own validation (must NOT already exist; image must be
  // on the allowlist; cpu/memory bounded) and its own approval gate bound
  // to `actionHashFor('incus.launch', { name })` — the SAME `{ name }`-only
  // binding as the destructive block, so the UI mints with payload `{ name }`.
  if (input.action === "launch") {
    // a. Must not already exist.
    const existing = await getMockRecord(input.name);
    if (existing) {
      audit({
        actorUserId: ctx.user.id,
        actorSessionId: null,
        actorIp: ctx.ip,
        actorUserAgent: ctx.userAgent,
        surface: "incus",
        action: "incus.bridge.reject",
        target: input.name,
        result: "denied",
        errorCode: "instance_exists",
        requestId: ctx.requestId,
        payload: { phase: "launch_exists", op: policyName, name: input.name },
      });
      return {
        status: "rejected",
        action: input.action,
        name: input.name,
        code: "instance_exists",
        reason: `instance '${input.name}' already exists`,
      };
    }

    // b. Image must be present + on the allowlist.
    const images = await listImages();
    const aliases = new Set(images.flatMap((i) => i.aliases));
    const image = (input.image ?? "").trim();
    if (!image || !aliases.has(image)) {
      audit({
        actorUserId: ctx.user.id,
        actorSessionId: null,
        actorIp: ctx.ip,
        actorUserAgent: ctx.userAgent,
        surface: "incus",
        action: "incus.bridge.reject",
        target: input.name,
        result: "denied",
        errorCode: "image_invalid",
        requestId: ctx.requestId,
        payload: { phase: "launch_image", op: policyName, name: input.name, image },
      });
      return {
        status: "rejected",
        action: input.action,
        name: input.name,
        code: "image_invalid",
        reason: image
          ? `image '${image}' is not on the image allowlist`
          : "launch requires an image alias",
      };
    }

    // c. Resolve cpu/memory with sane defaults + defensive bounds.
    const cpu = input.cpu ?? 2;
    const memory = input.memory ?? 4096;
    if (
      !Number.isInteger(cpu) ||
      cpu < 1 ||
      cpu > 64 ||
      !Number.isInteger(memory) ||
      memory < 128 ||
      memory > 262144
    ) {
      audit({
        actorUserId: ctx.user.id,
        actorSessionId: null,
        actorIp: ctx.ip,
        actorUserAgent: ctx.userAgent,
        surface: "incus",
        action: "incus.bridge.reject",
        target: input.name,
        result: "denied",
        errorCode: "instance_name_invalid",
        requestId: ctx.requestId,
        payload: { phase: "launch_limits", op: policyName, name: input.name, cpu, memory },
      });
      return {
        status: "rejected",
        action: input.action,
        name: input.name,
        code: "instance_name_invalid",
        reason: `launch limits out of range (cpu=${cpu} must be 1..64, memory=${memory} must be 128..262144 MiB)`,
      };
    }

    // d. Approval gate — bound to `{ name }` only (PB-5), mirroring the
    //    destructive block exactly.
    const actionHash = actionHashFor(policyName, { name: input.name });
    if (!ctx.approvalToken) {
      audit({
        actorUserId: ctx.user.id,
        actorSessionId: null,
        actorIp: ctx.ip,
        actorUserAgent: ctx.userAgent,
        surface: "incus",
        action: "incus.bridge.approval_required",
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
        message: `incus launch of '${input.name}' requires an approval token`,
      };
    }
    const { verifyApproval, consumeApproval } = await import("../approval");
    const v = verifyApproval(ctx.approvalToken, asSessionId(ctx.sessionId));
    if (!v.ok) {
      audit({
        actorUserId: ctx.user.id,
        actorSessionId: null,
        actorIp: ctx.ip,
        actorUserAgent: ctx.userAgent,
        surface: "incus",
        action: "incus.bridge.reject",
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
        reason: `approval token ${v.reason}`,
      };
    }
    if (v.claims.actionHash !== actionHash) {
      audit({
        actorUserId: ctx.user.id,
        actorSessionId: null,
        actorIp: ctx.ip,
        actorUserAgent: ctx.userAgent,
        surface: "incus",
        action: "incus.bridge.reject",
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
    // Single-use: burn the token before running the launch.
    const consumed = consumeApproval(ctx.approvalToken, asSessionId(ctx.sessionId));
    if (!consumed.ok) {
      audit({
        actorUserId: ctx.user.id,
        actorSessionId: null,
        actorIp: ctx.ip,
        actorUserAgent: ctx.userAgent,
        surface: "incus",
        action: "incus.bridge.reject",
        target: input.name,
        result: "denied",
        errorCode: consumed.reason,
        requestId: ctx.requestId,
        payload: { phase: "approval_consume", op: policyName, reason: consumed.reason },
      });
      return {
        status: "rejected",
        action: input.action,
        name: input.name,
        code: approvalRejectionCode(consumed.reason),
        reason: `approval token ${consumed.reason}`,
      };
    }

    // e. Run the executor with a synthesized instance ctx (no DB record yet).
    const nowIso = new Date().toISOString();
    try {
      const result = await executor({
        instance: {
          name: input.name,
          slug: input.name,
          status: "running",
          type: "container",
          image,
          cpu,
          memory,
          config: {} as IncusInstance["config"],
          devices: {},
          lastValidation: null,
          createdBy: ctx.user.id,
          createdAt: nowIso,
          updatedAt: nowIso,
        },
        action: "launch",
        user: ctx.user,
        ip: ctx.ip,
        requestId: ctx.requestId,
      });
      // A non-zero exit means `incus launch` failed and rolled back — no
      // instance exists. Report it as an error so the UI surfaces the failure
      // instead of telling the operator the container was provisioned.
      if (result.exitCode !== 0) {
        audit({
          actorUserId: ctx.user.id,
          actorSessionId: null,
          actorIp: ctx.ip,
          actorUserAgent: ctx.userAgent,
          surface: "incus",
          action: "incus.bridge.dispatch",
          target: input.name,
          result: "failure",
          errorCode: "executor_error",
          requestId: ctx.requestId,
          payload: { op: policyName, image, cpu, memory, exitCode: result.exitCode },
        });
        return {
          status: "rejected",
          action: input.action,
          name: input.name,
          code: "executor_error",
          reason: result.stderr.trim() || `incus launch failed (exit ${result.exitCode})`,
        };
      }
      audit({
        actorUserId: ctx.user.id,
        actorSessionId: null,
        actorIp: ctx.ip,
        actorUserAgent: ctx.userAgent,
        surface: "incus",
        action: "incus.bridge.dispatch",
        target: input.name,
        result: "success",
        errorCode: null,
        requestId: ctx.requestId,
        payload: {
          op: policyName,
          image,
          cpu,
          memory,
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
        instance: result.instance,
        durationMs: Date.now() - t0,
      };
    } catch (e) {
      audit({
        actorUserId: ctx.user.id,
        actorSessionId: null,
        actorIp: ctx.ip,
        actorUserAgent: ctx.userAgent,
        surface: "incus",
        action: "incus.bridge.dispatch",
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

  // 3. Instance exists + is allowlisted.
  const instance = await getMockRecord(input.name);
  if (!instance) {
    audit({
      actorUserId: ctx.user.id,
      actorSessionId: null,
      actorIp: ctx.ip,
      actorUserAgent: ctx.userAgent,
      surface: "incus",
      action: "incus.bridge.reject",
      target: input.name,
      result: "failure",
      errorCode: "unknown_instance",
      requestId: ctx.requestId,
      payload: { phase: "lookup", op: policyName, name: input.name },
    });
    return {
      status: "rejected",
      action: input.action,
      name: input.name,
      code: "unknown_instance",
      reason: `instance '${input.name}' is not in the executor's snapshot`,
    };
  }
  if (!instance.allowlisted) {
    audit({
      actorUserId: ctx.user.id,
      actorSessionId: null,
      actorIp: ctx.ip,
      actorUserAgent: ctx.userAgent,
      surface: "incus",
      action: "incus.bridge.reject",
      target: input.name,
      result: "denied",
      errorCode: "not_allowlisted",
      requestId: ctx.requestId,
      payload: { phase: "allowlist_instance", op: policyName, name: input.name },
    });
    return {
      status: "rejected",
      action: input.action,
      name: input.name,
      code: "not_allowlisted",
      reason: `instance '${input.name}' is not allowlisted`,
    };
  }

  // 3a. Delete confirmation phrase.
  if (input.action === "delete") {
    if ((input.confirmation ?? "").trim().toLowerCase() !== DELETE_CONFIRMATION_PHRASE) {
      audit({
        actorUserId: ctx.user.id,
        actorSessionId: null,
        actorIp: ctx.ip,
        actorUserAgent: ctx.userAgent,
        surface: "incus",
        action: "incus.bridge.reject",
        target: input.name,
        result: "denied",
        errorCode: "confirmation_required",
        requestId: ctx.requestId,
        payload: { phase: "confirmation", op: policyName, name: input.name },
      });
      return {
        status: "rejected",
        action: input.action,
        name: input.name,
        code: "confirmation_required",
        reason: `delete requires a typed confirmation of '${DELETE_CONFIRMATION_PHRASE}'`,
      };
    }
  }

  // 4. Destructive action → approval gate.
  if (DESTRUCTIVE_ACTIONS_INTERNAL.has(input.action)) {
    const actionHash = actionHashFor(policyName, { name: input.name });
    if (!ctx.approvalToken) {
      audit({
        actorUserId: ctx.user.id,
        actorSessionId: null,
        actorIp: ctx.ip,
        actorUserAgent: ctx.userAgent,
        surface: "incus",
        action: "incus.bridge.approval_required",
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
        message: `Destructive incus action '${input.action}' on '${input.name}' requires an approval token`,
      };
    }
    // Verify the token. The approval is bound to the caller's
    // `SessionId` (THREAT_MODEL §3.4, PB-1).
    const { verifyApproval, consumeApproval } = await import("../approval");
    const v = verifyApproval(ctx.approvalToken, asSessionId(ctx.sessionId));
    if (!v.ok) {
      const reason = `approval token ${v.reason}`;
      audit({
        actorUserId: ctx.user.id,
        actorSessionId: null,
        actorIp: ctx.ip,
        actorUserAgent: ctx.userAgent,
        surface: "incus",
        action: "incus.bridge.reject",
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
    // Bind the approval to this specific op + name (PB-5).
    if (v.claims.actionHash !== actionHash) {
      audit({
        actorUserId: ctx.user.id,
        actorSessionId: null,
        actorIp: ctx.ip,
        actorUserAgent: ctx.userAgent,
        surface: "incus",
        action: "incus.bridge.reject",
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
    // Consume the token so it is single-use: a replay within the 60s TTL is
    // rejected (already_used). verifyApproval above does NOT burn it — without
    // this consume an incus.stop/restart/delete token could be replayed,
    // unlike docker (bridge.ts) and systemd (systemd.ts), which both consume.
    const consumed = consumeApproval(ctx.approvalToken, asSessionId(ctx.sessionId));
    if (!consumed.ok) {
      audit({
        actorUserId: ctx.user.id,
        actorSessionId: null,
        actorIp: ctx.ip,
        actorUserAgent: ctx.userAgent,
        surface: "incus",
        action: "incus.bridge.reject",
        target: input.name,
        result: "denied",
        errorCode: consumed.reason,
        requestId: ctx.requestId,
        payload: { phase: "approval_consume", op: policyName, reason: consumed.reason },
      });
      return {
        status: "rejected",
        action: input.action,
        name: input.name,
        code: approvalRejectionCode(consumed.reason),
        reason: `approval token ${consumed.reason}`,
      };
    }
  }

  // 5. Run the executor.
  try {
    const result = await executor({
      instance: {
        name: instance.name,
        slug: instance.slug,
        status: instance.status,
        type: instance.type,
        image: instance.image,
        cpu: instance.cpu ?? null,
        memory: instance.memory ?? null,
        config: instance.config,
        devices: instance.devices,
        lastValidation: instance.lastValidation ?? null,
        createdBy: instance.createdBy,
        createdAt: instance.createdAt,
        updatedAt: instance.updatedAt,
      },
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
      surface: "incus",
      action: "incus.bridge.dispatch",
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
      instance: result.instance,
      durationMs: Date.now() - t0,
    };
  } catch (e) {
    audit({
      actorUserId: ctx.user.id,
      actorSessionId: null,
      actorIp: ctx.ip,
      actorUserAgent: ctx.userAgent,
      surface: "incus",
      action: "incus.bridge.dispatch",
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

// ---------------------------------------------------------------------------
// Exec-named (PB-4). Mirrors the terminal pty-bridge's allowlist pattern.
// ---------------------------------------------------------------------------

/** The closed set of shell ops the UI may invoke via exec-named. */
export const EXEC_NAMED_OPS: ReadonlySet<IncusShellOp> = new Set<IncusShellOp>([
  "term.ps",
  "term.df",
  "term.ls",
  "term.cat",
  "term.tail_log",
]);

/**
 * M2 deterministic exec. Mocks stdout/stderr based on the op without
 * ever invoking a shell. M3 swaps to `incus exec <name> -- <argv>`.
 */
export interface MockExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type MockExecNamedExecutor = (
  op: IncusShellOp,
  args: Readonly<Record<string, unknown>>,
  name: string,
) => Promise<MockExecResult>;

let execNamedExecutor: MockExecNamedExecutor = async (op, args, name) => {
  if (!currentMock) {
    const entry = allowlistedCommand(op);
    if (!entry || entry.surface !== "terminal") throw new Error("Unknown Incus terminal operation");
    const argv = entry.argv.map((arg) => {
      const placeholder = /^<([a-zA-Z_][a-zA-Z0-9_-]*)>$/.exec(arg);
      if (!placeholder) return arg;
      const value = args[placeholder[1]];
      if ((typeof value !== "string" && typeof value !== "number") ||
        String(value).startsWith("-") || String(value).includes("\0")) {
        throw new Error(`Invalid argument ${placeholder[1]}`);
      }
      return String(value);
    });
    if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(name)) throw new Error("Invalid Incus instance name");
    try {
      const project = await resolveInstanceProject(name);
      const { stdout, stderr } = await execFileAsync("incus", ["exec", name, "--project", project, "--", ...argv], {
        timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
      });
      return { stdout, stderr, exitCode: 0 };
    } catch (err) {
      const error = err as { code?: number | string; stdout?: string; stderr?: string };
      return { stdout: error.stdout ?? "", stderr: error.stderr ?? "Incus exec unavailable",
        exitCode: typeof error.code === "number" ? error.code : 1 };
    }
  }
  switch (op) {
    case "term.ps":
      return {
        stdout: `root         1  0.0  0.1  1234  5678 ?        Ss   00:00   0:01 /init ${name}`,
        stderr: "",
        exitCode: 0,
      };
    case "term.df":
      return {
        stdout: `Filesystem      Size  Used Avail Use% Mounted on\n/dev/root        20G  2.4G   17G  13% /`,
        stderr: "",
        exitCode: 0,
      };
    case "term.ls": {
      const path = typeof args.path === "string" ? args.path : "/";
      return {
        stdout: `drwxr-xr-x  2 root root 4096 May 12 10:00 ${path}`,
        stderr: "",
        exitCode: 0,
      };
    }
    case "term.cat": {
      return {
        stdout: `${name}\n`,
        stderr: "",
        exitCode: 0,
      };
    }
    case "term.tail_log": {
      const unit = typeof args.unit === "string" ? args.unit : "sshd";
      const n = typeof args.n === "number" ? args.n : 10;
      return {
        stdout: `-- Logs begin at ${new Date().toISOString()} --\n${Array.from({ length: n })
          .map((_, i) => `May 12 10:0${i % 10}:00 ${name} ${unit}[${100 + i}]: ready`)
          .join("\n")}`,
        stderr: "",
        exitCode: 0,
      };
    }
    default:
      return { stdout: "", stderr: "Unknown op", exitCode: 1 };
  }
};

/** Test helper: swap the exec-named executor. Pass `null` to reset. */
export function setExecNamedExecutorForTests(fn: MockExecNamedExecutor | null): void {
  if (process.env.NODE_ENV !== "test") throw new Error("Incus executor injection is test-only");
  execNamedExecutor = fn ?? execNamedExecutor;
}

export interface ExecDispatchInput {
  op: IncusShellOp;
  args: Readonly<Record<string, unknown>>;
}

export interface ExecDispatchContext {
  user: User;
  ip: string;
  userAgent: string | null;
  requestId: string;
}

export type ExecDispatchResult =
  | {
      status: "accepted";
      op: IncusShellOp;
      stdout: string;
      stderr: string;
      exitCode: number;
    }
  | {
      status: "rejected";
      op: IncusShellOp;
      code: "unknown_op" | "arg_smuggling" | "argv_bash_c" | "arg_type" | "unknown_instance";
      reason: string;
      field?: string;
    };

/**
 * PB-4: dispatch an allowlisted exec-named op against a named
 * instance.
 *
 * Re-runs the policy + arg-smuggling guards (SR-019 + T-104) so a
 * misconfigured caller cannot smuggle `bash -c <userstring>`. The
 * mock executor is in-process; M3 swaps to the real `incus exec
 * <name> -- <allowlisted-subcommand>`.
 */
export async function dispatchExecNamed(
  name: string,
  input: ExecDispatchInput,
  ctx: ExecDispatchContext,
): Promise<ExecDispatchResult> {
  // 1. Instance must exist (no PII leak; we return `unknown_instance`
  //    not `not_found` so the caller can't enumerate names).
  const instance = await getInstance(name);
  if (!instance) {
    audit({
      actorUserId: ctx.user.id,
      actorSessionId: null,
      actorIp: ctx.ip,
      actorUserAgent: ctx.userAgent,
      surface: "incus",
      action: "incus.exec_named.reject",
      target: name,
      result: "failure",
      errorCode: "unknown_instance",
      requestId: ctx.requestId,
      payload: { phase: "lookup", op: input.op, name },
    });
    return {
      status: "rejected",
      op: input.op,
      code: "unknown_instance",
      reason: `instance '${name}' is not in the executor's snapshot`,
    };
  }

  // 2. Op must be on the closed allowlist.
  if (!EXEC_NAMED_OPS.has(input.op)) {
    audit({
      actorUserId: ctx.user.id,
      actorSessionId: null,
      actorIp: ctx.ip,
      actorUserAgent: ctx.userAgent,
      surface: "incus",
      action: "incus.exec_named.reject",
      target: name,
      result: "failure",
      errorCode: "unknown_op",
      requestId: ctx.requestId,
      payload: { phase: "op_allowlist", op: input.op },
    });
    return {
      status: "rejected",
      op: input.op,
      code: "unknown_op",
      reason: `op '${input.op}' is not on the incus exec-named allowlist`,
    };
  }

  // 3. Recursive arg-smuggling scan (PB-4 / T-104 / SR-019).
  // Re-uses the policy module's `validateShellArg` so the same
  // denylist + arg-smuggling patterns guard every privileged
  // surface.
  const { validateShellArg } = await import("../policy");
  const argErrors: { field: string; reason: string; matched: string }[] = [];
  function walk(value: unknown, path: string): void {
    if (typeof value === "string") {
      const r = validateShellArg(value);
      if (!r.ok) argErrors.push({ field: path, reason: r.reason, matched: r.matched });
      return;
    }
    if (value === null || typeof value === "number" || typeof value === "boolean") return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    if (typeof value === "object") {
      Object.entries(value as Record<string, unknown>).forEach(([k, v]) => {
        walk(v, path ? `${path}.${k}` : k);
      });
    }
  }
  walk(input.args, "");
  if (argErrors.length > 0) {
    const first = argErrors[0];
    audit({
      actorUserId: ctx.user.id,
      actorSessionId: null,
      actorIp: ctx.ip,
      actorUserAgent: ctx.userAgent,
      surface: "incus",
      action: "incus.exec_named.reject",
      target: name,
      result: "denied",
      errorCode: "arg_smuggling",
      requestId: ctx.requestId,
      payload: { phase: "arg_smuggling", hits: argErrors, op: input.op },
    });
    return {
      status: "rejected",
      op: input.op,
      code: "arg_smuggling",
      reason: first.reason,
      field: first.field || "_root",
    };
  }

  // 4. PB-4 belt-and-braces: reject any input that contains a
  //    literal `bash -c` pair. The route already rejects the op
  //    name, but this catches a future caller that pre-constructs
  //    an argv from a config table.
  function argvContainsBashDashC(value: unknown): boolean {
    if (typeof value === "string") {
      return /\b(bash|sh|zsh|ksh)\s+-c\b/.test(value);
    }
    if (value === null || typeof value !== "object") return false;
    if (Array.isArray(value)) return value.some(argvContainsBashDashC);
    return Object.values(value as Record<string, unknown>).some(argvContainsBashDashC);
  }
  if (argvContainsBashDashC(input.args)) {
    audit({
      actorUserId: ctx.user.id,
      actorSessionId: null,
      actorIp: ctx.ip,
      actorUserAgent: ctx.userAgent,
      surface: "incus",
      action: "incus.exec_named.reject",
      target: name,
      result: "denied",
      errorCode: "argv_bash_c",
      requestId: ctx.requestId,
      payload: { phase: "argv_bash_c", op: input.op },
    });
    return {
      status: "rejected",
      op: input.op,
      code: "argv_bash_c",
      reason: "args contain a literal `bash -c` pair (SR-019)",
    };
  }

  // 5. Run the executor.
  let result: MockExecResult;
  try {
    result = await execNamedExecutor(input.op, input.args, name);
  } catch (e) {
    audit({
      actorUserId: ctx.user.id,
      actorSessionId: null,
      actorIp: ctx.ip,
      actorUserAgent: ctx.userAgent,
      surface: "incus",
      action: "incus.exec_named.dispatch",
      target: name,
      result: "failure",
      errorCode: "executor_error",
      requestId: ctx.requestId,
      payload: { op: input.op, error: (e as Error).message },
    });
    return {
      status: "rejected",
      op: input.op,
      code: "arg_type",
      reason: `executor error: ${(e as Error).message}`,
    };
  }

  audit({
    actorUserId: ctx.user.id,
    actorSessionId: null,
    actorIp: ctx.ip,
    actorUserAgent: ctx.userAgent,
    surface: "incus",
    action: "incus.exec_named.dispatch",
    target: name,
    result: result.exitCode === 0 ? "success" : "failure",
    errorCode: null,
    requestId: ctx.requestId,
    payload: { op: input.op, exitCode: result.exitCode },
  });

  return {
    status: "accepted",
    op: input.op,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  };
}

// ---------------------------------------------------------------------------
// Allowlist projection — used by the +page.server.ts loader for the UI.
// ---------------------------------------------------------------------------

/** Project the incus-surface allowlist into a UI shape. */
export function listInstanceActions(): readonly {
  action: IncusActionKind;
  description: string;
  requiresApproval: boolean;
}[] {
  return (["start", "stop", "restart", "delete", "launch", "list", "exec-named"] as const).map(
    (action) => {
      const policyName = `incus.${action}`;
      const entry = allowlistedCommand(policyName);
      return {
        action,
        description: entry?.description ?? `incus ${action} on an allowlisted instance.`,
        requiresApproval: entry?.requiresApproval ?? DESTRUCTIVE_ACTIONS_INTERNAL.has(action),
      };
    },
  );
}

// ---------------------------------------------------------------------------
// Convenience re-exports for tests / consumers.
// ---------------------------------------------------------------------------

/** The default seed. Exposed so tests can assert against a known set. */
export const SEED_INSTANCES: readonly MockInstanceRecord[] = SEED_INSTANCES_INTERNAL;

/** Re-export the destructive-action set for tests. */
export const DESTRUCTIVE_ACTIONS: ReadonlySet<IncusActionKind> = DESTRUCTIVE_ACTIONS_INTERNAL;
