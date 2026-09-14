/**
 * Docker prune bridge (plan 0.5 — control-surface honesty).
 *
 * Powers the Command Palette "Docker prune (dry-run)" action with a REAL
 * reclaimable estimate, and a SAFE prune that only reclaims dangling images +
 * build cache. This is a DEDICATED bridge, deliberately separate from the
 * agent-gateway docker bridge (`@/server/docker/bridge`): that bridge's
 * named-op allowlist is for tool dispatch and verifies per-op approval tokens.
 * Here we issue a fixed argv for two well-known, non-destructive prune verbs.
 *
 * Safety invariants (DB data lives in Docker volumes):
 *   - estimate runs ONLY `docker system df` (read-only).
 *   - prune runs ONLY `docker image prune -f` (dangling) and
 *     `docker builder prune -f` (build cache).
 *   - NEVER `-a` / `--all`, NEVER `--volumes`, NEVER `docker system prune`.
 *
 * Executor injection mirrors `@/server/agents/control`: a module-level
 * `Executor` type + a default that shells out via `node:child_process execFile`
 * (no shell, no string interpolation), swappable in tests via
 * `setExecutorForTests`. The service runs as root, so the default executor
 * invokes `/usr/bin/docker` directly with a fixed argv.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Executor seam
// ---------------------------------------------------------------------------

/**
 * Executor — the seam tests swap. Receives the docker argv (e.g.
 * `["system", "df", "--format", "{{json .}}"]`) and returns the captured
 * streams + exit code. Never throws; non-zero exits return the captured text.
 */
export type Executor = (argv: readonly string[]) => Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}>;

const DOCKER = "/usr/bin/docker";

const realDockerExecutor: Executor = async (argv) => {
  try {
    const { stdout, stderr } = await execFileAsync(DOCKER, [...argv], {
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { stdout: stdout ?? "", stderr: stderr ?? "", exitCode: 0 };
  } catch (err) {
    const e = err as {
      code?: number | string;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? e.message ?? "docker exec failed",
      exitCode: typeof e.code === "number" ? e.code : 1,
    };
  }
};

let executor: Executor = realDockerExecutor;

/** Test helper: swap the executor. Pass `null` to reset to the real one. */
export function setExecutorForTests(fn: Executor | null): void {
  executor = fn ?? realDockerExecutor;
}

// ---------------------------------------------------------------------------
// Byte parsing
// ---------------------------------------------------------------------------

const UNIT_MULTIPLIER: Record<string, number> = {
  B: 1,
  KB: 1000,
  MB: 1000 ** 2,
  GB: 1000 ** 3,
  TB: 1000 ** 4,
  PB: 1000 ** 5,
  KIB: 1024,
  MIB: 1024 ** 2,
  GIB: 1024 ** 3,
  TIB: 1024 ** 4,
  PIB: 1024 ** 5,
};

/**
 * Parse a docker-formatted size string into bytes. Docker emits sizes like
 * `"18.56GB"`, `"663.6MB"`, `"1.154MB (0%)"`, `"0B (0%)"`. We take the leading
 * `<number><unit>` token and ignore any trailing ` (NN%)` percentage. Returns 0
 * for unparseable input (never throws).
 */
export function parseDockerSize(raw: string): number {
  const m = /^\s*([\d.]+)\s*([A-Za-z]+)/.exec(raw);
  if (!m) return 0;
  const value = Number.parseFloat(m[1]);
  if (!Number.isFinite(value)) return 0;
  const unit = m[2].toUpperCase();
  const mult = UNIT_MULTIPLIER[unit];
  if (!mult) return 0;
  return Math.round(value * mult);
}

// ---------------------------------------------------------------------------
// estimateReclaimable — `docker system df --format "{{json .}}"`
// ---------------------------------------------------------------------------

/** One line of `docker system df --format "{{json .}}"`. */
interface SystemDfRow {
  Type?: string;
  Reclaimable?: string;
}

export interface ReclaimableEstimate {
  reclaimableBytes: number;
  breakdown: { images: number; buildCache: number; containers: number };
  /** True when `docker system df` could not be read (estimate is all zeros). */
  unavailable?: boolean;
}

/**
 * Estimate reclaimable Docker disk space from `docker system df`. Parses the
 * per-type `Reclaimable` fields into real bytes. Never throws — on any failure
 * (non-zero exit, unparseable output) returns zeros with `unavailable: true`.
 */
export async function estimateReclaimable(): Promise<ReclaimableEstimate> {
  const res = await executor(["system", "df", "--format", "{{json .}}"]);
  if (res.exitCode !== 0 || !res.stdout.trim()) {
    return {
      reclaimableBytes: 0,
      breakdown: { images: 0, buildCache: 0, containers: 0 },
      unavailable: true,
    };
  }

  const rows = res.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as SystemDfRow;
      } catch {
        return null;
      }
    })
    .filter((row): row is SystemDfRow => row !== null);

  // "Local Volumes" intentionally excluded — volumes hold DB data and are never
  // part of the safe prune scope.
  const byType = (type: string): number => {
    const row = rows.find((r) => r.Type === type);
    return row ? parseDockerSize(row.Reclaimable ?? "") : 0;
  };

  const images = byType("Images");
  const buildCache = byType("Build Cache");
  const containers = byType("Containers");
  const parsedAny = rows.length > 0;

  if (!parsedAny) {
    return {
      reclaimableBytes: 0,
      breakdown: { images: 0, buildCache: 0, containers: 0 },
      unavailable: true,
    };
  }

  // The safe prune only reclaims dangling images + build cache; containers
  // reclaimable is surfaced for transparency but excluded from the headline.
  return {
    reclaimableBytes: images + buildCache,
    breakdown: { images, buildCache, containers },
  };
}

// ---------------------------------------------------------------------------
// runPrune — SAFE scope only (dangling images + build cache)
// ---------------------------------------------------------------------------

export interface PruneResult {
  reclaimedBytes: number;
  raw: string;
}

/** Sum every `Total reclaimed space: <size>` line docker prints across runs. */
function sumReclaimed(raw: string): number {
  const matches = raw.matchAll(/Total reclaimed space:\s*(.+)/gi);
  return Array.from(matches).reduce((total, m) => total + parseDockerSize(m[1]), 0);
}

/**
 * Run the SAFE prune: `docker image prune -f` (dangling images only) then
 * `docker builder prune -f` (build cache). NEVER touches volumes, never `-a`,
 * never `docker system prune`. Sums the "Total reclaimed space" from both.
 */
export async function runPrune(): Promise<PruneResult> {
  const imageRes = await executor(["image", "prune", "-f"]);
  const builderRes = await executor(["builder", "prune", "-f"]);
  const raw = [imageRes.stdout, builderRes.stdout].filter(Boolean).join("\n");
  return { reclaimedBytes: sumReclaimed(raw), raw };
}
