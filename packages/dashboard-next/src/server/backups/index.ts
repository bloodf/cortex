/**
 * Backups bridge — server-side reader for CortexOS backup run state (MP-024b).
 *
 * Discovers Cortex cold archives and their verification receipts from the
 * configured backup destination. A published archive is successful only with
 * a matching verified-cold-archive receipt; partial archives remain incomplete.
 * Receipt verification is not a restore proof.
 *
 * Public surface:
 *   - listBackupRuns()                     → BackupRunRow[]
 *   - setBackupExecutorForTests(fn)        → test helper
 *   - setBackupsRootForTests(root)         → test helper
 *   - resetBackupsForTests()               → test helper
 */

import { readdir, lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dashboardPaths } from "@/server/paths";

import { runSequentially } from "@/lib/sequential";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Executor interface — seam between tests (mock) and production (systemctl).
// ---------------------------------------------------------------------------

export interface BackupExecutorResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type BackupExecutor = (argv: readonly string[]) => Promise<BackupExecutorResult>;

// ---------------------------------------------------------------------------
// Real executor (Linux only) — execFile with fixed argv, no shell.
// ---------------------------------------------------------------------------

const realBackupExecutor: BackupExecutor = async (argv) => {
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
// Mock executor (non-Linux/CI) — deterministic empty fallback.
// ---------------------------------------------------------------------------

const emptyMockExecutor: BackupExecutor = async () => ({
  stdout: "",
  stderr: "",
  exitCode: 0,
});

// ---------------------------------------------------------------------------
// Module-level state — executor and root are the only swappable pieces.
// ---------------------------------------------------------------------------

let backupExecutor: BackupExecutor = () => {
  throw new Error("backups bridge: executor used before init");
};
let backupsRoot: string | undefined;

(function init() {
  if (process.env.NODE_ENV !== "test") {
    if (process.env.CORTEX_BACKUPS_BRIDGE_REAL === "0") {
      throw new Error("CORTEX_BACKUPS_BRIDGE_REAL=0 is test-only; remove it to read real backups");
    }
    if (process.platform !== "linux") throw new Error("Backup bridge requires Linux");
  }
  const useReal = process.platform === "linux" && process.env.CORTEX_BACKUPS_BRIDGE_REAL !== "0";
  backupExecutor = useReal ? realBackupExecutor : emptyMockExecutor;
})();

/** Test helper: swap the systemctl executor. Pass `null` to reset to the empty mock. */
export function setBackupExecutorForTests(fn: BackupExecutor | null): void {
  if (process.env.NODE_ENV !== "test") throw new Error("Backup executor injection is test-only");
  backupExecutor = fn ?? emptyMockExecutor;
}

/** Test helper: swap the backup root directory. */
export function setBackupsRootForTests(root: string): void {
  if (process.env.NODE_ENV !== "test") throw new Error("Backup root injection is test-only");
  backupsRoot = root;
}

/** Reset the bridge to the empty mock executor and default root. */
export function resetBackupsForTests(): void {
  if (process.env.NODE_ENV !== "test") throw new Error("Backup mock controls are test-only");
  backupExecutor = emptyMockExecutor;
  backupsRoot = undefined;
}

// ---------------------------------------------------------------------------
// Row contract exposed to server functions.
// ---------------------------------------------------------------------------

export interface BackupRunRow {
  /** Run identifier derived from the archive basename. */
  id: string;
  /** ISO-8601 timestamp parsed from the run identifier. */
  timestamp: string;
  /** Absolute path to the published or partial archive. */
  target: string;
  /** Size of a published archive in bytes, or null for incomplete runs. */
  sizeBytes: number | null;
  /** High-level result of the backup run. */
  status: "success" | "failed" | "running" | "unknown";
}

// ---------------------------------------------------------------------------
// Helpers — environment resolution, parsing, status mapping.
// ---------------------------------------------------------------------------

const STAMP_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\.(\d{6})Z$/;
const ARCHIVE_RE = /^cortex-(\d{8}T\d{6}\.\d{6}Z)\.tar\.(gz|partial)$/;

function parseStamp(stamp: string): string | null {
  const m = STAMP_RE.exec(stamp);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7].slice(0, 3)}Z`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime()) || d.toISOString() !== iso) return null;
  return `${iso.slice(0, -4)}${m[7]}Z`;
}

async function hasVerifiedReceipt(root: string, stamp: string, archive: string): Promise<boolean> {
  try {
    const receiptPath = path.join(root, `cortex-${stamp}.json`);
    const info = await lstat(receiptPath);
    if (!info.isFile() || info.size > 1024 * 1024) return false;
    const receipt: unknown = JSON.parse(await readFile(receiptPath, "utf8"));
    if (!receipt || typeof receipt !== "object") return false;
    const value = receipt as Record<string, unknown>;
    return value.schema_version === 1 &&
      value.state === "verified-cold-archive" &&
      value.created_utc === stamp &&
      value.archive === archive;
  } catch {
    return false;
  }
}

function parseEnvironment(stdout: string): Record<string, string> {
  const env: Record<string, string> = {};
  stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((trimmed) => trimmed.startsWith("Environment="))
    .forEach((trimmed) => {
      trimmed
        .slice("Environment=".length)
        .trim()
        .split(/\s+/)
        .forEach((pair) => {
          const idx = pair.indexOf("=");
          if (idx !== -1) {
            env[pair.slice(0, idx)] = pair.slice(idx + 1);
          }
        });
    });
  return env;
}

async function resolveBackupRoot(): Promise<string> {
  const envRoot = process.env.CORTEX_BACKUP_ROOT;
  if (envRoot) return dashboardPaths().backups;

  const result = await backupExecutor(["show", "cortex-backup.service", "--property=Environment"]);
  if (result.exitCode === 0) {
    const env = parseEnvironment(result.stdout);
    if (env.BACKUP_ROOT) return env.BACKUP_ROOT;
  }

  return backupsRoot ?? dashboardPaths().backups;
}

async function getServiceState(name: string): Promise<BackupRunRow["status"]> {
  const result = await backupExecutor([
    "show",
    name,
    "--property=ActiveState,SubState,StateChangeTimestamp",
    "--value",
  ]);
  if (result.exitCode !== 0) return "unknown";

  const lines = result.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const activeState = lines[0] ?? "";
  const subState = lines[1] ?? "";

  if (activeState === "active") return "running";
  if (activeState === "failed" || subState === "failed") return "failed";
  return "unknown";
}

interface RunEntry {
  stamp: string;
  timestamp: string;
  filePath: string;
  isFile: boolean;
  sizeBytes: number | null;
  verified: boolean;
}

async function scanRuns(root: string): Promise<RunEntry[]> {
  let entries: string[] = [];
  try {
    entries = await readdir(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error("Backup inventory unavailable", { cause: err });
  }

  const scanned = await runSequentially(entries, async (name): Promise<RunEntry | null> => {
    const match = ARCHIVE_RE.exec(name);
    if (!match) return null;
    const stamp = match[1];
    const timestamp = parseStamp(stamp);
    if (!timestamp) return null;
    const filePath = path.join(root, name);
    const st = await lstat(filePath).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return null;
      throw err;
    });
    if (!st?.isFile()) return null;
    const published = match[2] === "gz";
    return {
      stamp,
      timestamp,
      filePath,
      isFile: published,
      sizeBytes: published ? st.size : null,
      verified: published && await hasVerifiedReceipt(root, stamp, filePath),
    };
  });

  const runs = new Map<string, RunEntry>();
  scanned
    .filter((entry): entry is RunEntry => entry !== null)
    .forEach((entry) => {
      if (entry.isFile || !runs.has(entry.stamp)) {
        runs.set(entry.stamp, entry);
      }
    });

  return Array.from(runs.values()).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

// ---------------------------------------------------------------------------
// Loader — parses published and partial archives.
// ---------------------------------------------------------------------------

/** List all discovered backup runs mapped to the fixed row contract. */
export async function listBackupRuns(): Promise<BackupRunRow[]> {
  const root = await resolveBackupRoot();
  const serviceState = await getServiceState("cortex-backup.service");
  const scanned = await scanRuns(root);

  const rows: BackupRunRow[] = scanned.map((entry): BackupRunRow => {
    let status: BackupRunRow["status"] = "failed";
    if (entry.isFile) {
      status = entry.verified ? "success" : "unknown";
    }
    if (!entry.isFile && serviceState === "running" && entry === scanned[0]) {
      status = "running";
    }
    return {
      id: entry.stamp,
      timestamp: entry.timestamp,
      target: entry.filePath,
      sizeBytes: entry.sizeBytes,
      status,
    };
  });

  return rows;
}
