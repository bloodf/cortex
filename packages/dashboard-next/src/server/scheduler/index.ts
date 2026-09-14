/**
 * Scheduler bridge — server-side reader for systemd timer units (MP-024a).
 *
 * Reads `systemctl list-timers --all --output=json` through a swappable
 * executor so node-environment tests can feed canned stdout without shelling
 * out. The real executor uses execFile with a FIXED argv array — never
 * `bash -c <string>`.
 *
 * Public surface:
 *   - listTimers()                       → TimerRow[]
 *   - setSchedulerExecutorForTests(fn)   → test helper
 *   - resetSchedulerForTests()           → test helper
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Executor interface — seam between tests (mock) and production (systemctl).
// ---------------------------------------------------------------------------

export interface SchedulerExecutorResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type SchedulerExecutor = (argv: readonly string[]) => Promise<SchedulerExecutorResult>;

// ---------------------------------------------------------------------------
// Real executor (Linux only) — execFile with fixed argv, no shell.
// ---------------------------------------------------------------------------

const realSchedulerExecutor: SchedulerExecutor = async (argv) => {
  try {
    const { stdout, stderr } = await execFileAsync("/usr/bin/systemctl", argv as string[], {
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { stdout: stdout ?? "", stderr: stderr ?? "", exitCode: 0 };
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string; message?: string };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? e.message ?? "systemctl exec failed",
      exitCode: typeof e.code === "number" ? e.code : 1,
    };
  }
};

// ---------------------------------------------------------------------------
// Mock executor (M2) — deterministic empty fallback for non-Linux/CI.
// ---------------------------------------------------------------------------

const emptyMockExecutor: SchedulerExecutor = async () => ({
  stdout: "[]",
  stderr: "",
  exitCode: 0,
});

// ---------------------------------------------------------------------------
// Module-level state — executor is the only swappable piece.
// ---------------------------------------------------------------------------

let schedulerExecutor: SchedulerExecutor = () => {
  throw new Error("scheduler bridge: executor used before init");
};

(function init() {
  if (process.env.NODE_ENV !== "test") {
    if (process.env.CORTEX_SCHEDULER_BRIDGE_REAL === "0") {
      throw new Error("CORTEX_SCHEDULER_BRIDGE_REAL=0 is test-only; remove it to use systemd timers");
    }
    if (process.platform !== "linux") throw new Error("Scheduler bridge requires Linux");
  }
  const useReal = process.platform === "linux" && process.env.CORTEX_SCHEDULER_BRIDGE_REAL !== "0";
  schedulerExecutor = useReal ? realSchedulerExecutor : emptyMockExecutor;
})();

/** Test helper: swap the executor. Pass `null` to reset to the empty mock. */
export function setSchedulerExecutorForTests(fn: SchedulerExecutor | null): void {
  if (process.env.NODE_ENV !== "test") throw new Error("Scheduler executor injection is test-only");
  schedulerExecutor = fn ?? emptyMockExecutor;
}

/** Reset the bridge to the empty mock executor. */
export function resetSchedulerForTests(): void {
  if (process.env.NODE_ENV !== "test") throw new Error("Scheduler mock controls are test-only");
  schedulerExecutor = emptyMockExecutor;
}

// ---------------------------------------------------------------------------
// Row contract exposed to server functions.
// ---------------------------------------------------------------------------

export interface TimerRow {
  /** The systemd timer unit name (e.g. `cortex-backup.timer`). */
  name: string;
  /** Human description of the timer. */
  description: string;
  /** Calendar schedule expression (`OnCalendar`) when available. */
  schedule: string;
  /** ISO-8601 timestamp of the next scheduled run, or null if none. */
  nextRun: string | null;
  /** ISO-8601 timestamp of the last run, or null if never run. */
  lastRun: string | null;
  /** High-level unit state (active/inactive/failed/unknown). */
  state: "active" | "inactive" | "failed" | "unknown";
  /** Whether the timer unit file is enabled. */
  enabled: boolean;
  /** The service unit this timer activates. */
  target: string;
}

interface RawTimerEntry {
  unit?: string;
  activates?: string;
  next?: number;
  last?: number;
  description?: string;
  schedule?: string;
  state?: string;
  enabled?: boolean;
}

function parseTimerState(state?: string): TimerRow["state"] {
  if (!state) return "unknown";
  const s = state.toLowerCase();
  if (s === "active") return "active";
  if (s === "inactive") return "inactive";
  if (s === "failed") return "failed";
  return "unknown";
}

function toIso(micros?: number): string | null {
  if (!micros || micros <= 0) return null;
  return new Date(micros / 1000).toISOString();
}

// ---------------------------------------------------------------------------
// Loader — parses `systemctl list-timers --all --output=json`.
// ---------------------------------------------------------------------------

/** List all systemd timer units. Runtime errors are not empty inventories. */
export async function listTimers(): Promise<TimerRow[]> {
  const result = await schedulerExecutor(["list-timers", "--all", "--output=json"]);
  if (result.exitCode !== 0) throw new Error("Systemd timer inventory unavailable");

  let raw: RawTimerEntry[] = [];
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    if (!Array.isArray(parsed)) throw new Error("Expected systemd timer array");
    raw = parsed as RawTimerEntry[];
  } catch (err) {
    throw new Error("Invalid systemd timer inventory", { cause: err });
  }

  const rows = raw
    .map((entry): TimerRow | null => {
      const name = entry.unit?.trim();
      if (!name) return null;
      const target = entry.activates?.trim() ?? "";
      const schedule = entry.schedule?.trim() ?? "";
      const description = entry.description?.trim() ?? name;
      const enabled = typeof entry.enabled === "boolean" ? entry.enabled : true;
      const state = parseTimerState(entry.state);
      return {
        name,
        description,
        schedule,
        nextRun: toIso(entry.next),
        lastRun: toIso(entry.last),
        state,
        enabled,
        target,
      };
    })
    .filter((r): r is TimerRow => r !== null);

  return rows.sort((a, b) => a.name.localeCompare(b.name));
}
