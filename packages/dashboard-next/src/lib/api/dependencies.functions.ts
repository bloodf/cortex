/**
 * Server functions — service dependency graph + autostart control.
 *
 * Gate pattern mirrors systemd.functions.ts exactly:
 * `defineServerFn({...})` middleware + `createServerFn().middleware([gate]).handler(serverFnNoop)`.
 *
 * Bundle safety: this module is imported by the client bundle (isomorphic
 * functions layer), so every `@/server/**` VALUE import is dynamic inside
 * handlers — the client bundle never sees server code (T-01). Types are
 * `import type` at top level (build-erased, no runtime code).
 *
 * Semantics:
 * - Edges carry `kind` (configured | observed) + `source` (seed | detected | manual).
 *   Absence of an edge NEVER proves a service unused.
 * - Only `source='manual'` edges are mutable through these gates; seed/detected
 *   rows are rejected at write time (protected by the SQL guard, not by trust).
 * - `setServiceAutostart` is approval-gated ("services.autostart") and runs a
 *   disable preflight: disabling a provider with active dependents → HTTP 409
 *   `{ code: "conflict", blocked: true, dependents: [...] }` unless `force: true`
 *   (which requires a fresh mint covering the force flag).
 * - Runtime stats (RAM/CPU) are best-effort: null on failure, never throw —
 *   the graph page must render without them.
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { defineServerFn, serverFnNoop } from "@/lib/api/define-server-fn";
import type { ScanResult } from "@/server/system/dependency-scan";
import type { DbClient } from "@/server/db/client";
import type { ServiceRecord } from "@/server/db/repos/services";

// ---------------------------------------------------------------------------
// Contract types (client-safe: no server-only imports)
// ---------------------------------------------------------------------------

export type DependencyEdgeKind = "configured" | "observed";
export type DependencyEdgeSource = "seed" | "detected" | "manual";

export interface DependencyEdge {
  id: number;
  /** Dependent (consumer) service slug. */
  sourceSlug: string;
  /** Dependency (provider) service slug. */
  targetSlug: string;
  kind: DependencyEdgeKind;
  source: DependencyEdgeSource;
  detail: string | null;
  lastSeenAt: string | null;
  createdAt: string;
}

export interface ServiceNodeInfo extends Omit<ServiceRecord, "containerNames"> {
  autostart: boolean;
  unitName: string | null;
  /** Parsed docker container names (column stores a JSON array string). */
  containerNames: string[] | null;
  running: boolean;
  memBytes: number | null;
  cpuPct: number | null;
  /** Slugs of services that depend on this node (edge sources targeting it). */
  dependents: string[];
}

export interface DependenciesPayload {
  nodes: ServiceNodeInfo[];
  edges: DependencyEdge[];
}

export interface AutostartBackendStatus {
  /** Backend was exercised: "ok" | "failed"; null when the service has no such backend. */
  systemd: "ok" | "failed" | null;
  docker: "ok" | "failed" | null;
  errors: string[];
}

export interface AutostartResult {
  ok: boolean;
  slug: string;
  enabled: boolean;
  /** True when the request was blocked by active dependents (HTTP 409). */
  blocked?: boolean;
  dependents?: string[];
  backends: AutostartBackendStatus;
}

// ---------------------------------------------------------------------------
// Injectable seams — replaced wholesale by tests (same mechanism as
// setSystemdRuntimeForTests in systemd.functions.ts).
// ---------------------------------------------------------------------------

export interface DependenciesDeps {
  db: () => DbClient;
  exec: (
    program: "systemctl" | "docker",
    args: readonly string[],
    opts?: { timeout?: number; maxBuffer?: number },
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  scan: () => Promise<ScanResult>;
}

let depsOverride: DependenciesDeps | null = null;

/** Test-only: swap DB/exec/scan seams. Pass null to restore production wiring. */
export function setDependenciesDepsForTests(next: DependenciesDeps | null): void {
  depsOverride = next;
}

async function resolveDeps(): Promise<DependenciesDeps> {
  if (depsOverride) return depsOverride;
  const [{ getDb }, { execPrivileged }, { scanDependencies }] = await Promise.all([
    import("@/server/db/client"),
    import("@/server/system/systemd"),
    import("@/server/system/dependency-scan"),
  ]);
  return { db: getDb, exec: execPrivileged, scan: scanDependencies };
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

const EDGE_KINDS: Record<string, true> = { configured: true, observed: true };
const EDGE_SOURCES: Record<string, true> = { seed: true, detected: true, manual: true };

interface EdgeRow extends Record<string, unknown> {
  id: number;
  source_slug: string;
  target_slug: string;
  kind: string;
  source: string;
  detail: string | null;
  last_seen_at: Date | string | null;
  created_at: Date | string;
}

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function edgeFromRow(row: EdgeRow): DependencyEdge {
  return {
    id: row.id,
    sourceSlug: row.source_slug,
    targetSlug: row.target_slug,
    kind: EDGE_KINDS[row.kind] ? (row.kind as DependencyEdgeKind) : "configured",
    source: EDGE_SOURCES[row.source] ? (row.source as DependencyEdgeSource) : "detected",
    detail: row.detail,
    lastSeenAt: toIso(row.last_seen_at),
    createdAt: toIso(row.created_at) ?? new Date(0).toISOString(),
  };
}

/** container_names is a JSON array string (or null); never trust, always parse defensively. */
function parseContainerNames(raw: string | null): string[] | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return null;
  }
}

/** docker stats "MemUsage" field: "1.234GiB / 7.6GiB" → bytes of the used half. */
function parseDockerMemBytes(memUsage: string): number | null {
  const match = /^([\d.]+)\s*([KMGT]?i?B)/i.exec(memUsage.trim());
  if (!match) return null;
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value)) return null;
  const unit = match[2].toLowerCase();
  let multiplier: number;
  switch (unit) {
    case "b":
      multiplier = 1;
      break;
    case "kb":
      multiplier = 1_000;
      break;
    case "kib":
      multiplier = 1_024;
      break;
    case "mb":
      multiplier = 1_000_000;
      break;
    case "mib":
      multiplier = 1_048_576;
      break;
    case "gb":
      multiplier = 1_000_000_000;
      break;
    case "gib":
      multiplier = 1_073_741_824;
      break;
    case "tb":
      multiplier = 1_000_000_000_000;
      break;
    case "tib":
      multiplier = 1_099_511_627_776;
      break;
    default:
      return null;
  }
  return Math.round(value * multiplier);
}

/** docker stats "CPUPerc" field: "0.50%" → 0.5. */
function parseDockerCpuPct(cpuPerc: string): number | null {
  const value = Number.parseFloat(cpuPerc.replace("%", "").trim());
  return Number.isFinite(value) ? value : null;
}

interface DockerStatEntry {
  Name?: string;
  MemUsage?: string;
  CPUPerc?: string;
}

/** Parse `docker stats --no-stream --format json` lines; never throws. */
function parseDockerStatsJson(
  stdout: string,
): Map<string, { memBytes: number | null; cpuPct: number | null }> {
  const byName = new Map<string, { memBytes: number | null; cpuPct: number | null }>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: DockerStatEntry;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed === null || typeof parsed !== "object") continue;
      entry = parsed;
    } catch {
      continue;
    }
    if (typeof entry.Name !== "string" || entry.Name.length === 0) continue;
    byName.set(entry.Name, {
      memBytes: typeof entry.MemUsage === "string" ? parseDockerMemBytes(entry.MemUsage) : null,
      cpuPct: typeof entry.CPUPerc === "string" ? parseDockerCpuPct(entry.CPUPerc) : null,
    });
  }
  return byName;
}

const SYSTEMD_MEMORY_NOT_SET = "18446744073709551615"; // [not set] sentinel from systemctl show

interface UnitRuntime {
  mainPid: number;
  memBytes: number | null;
}

/** Parse `systemctl show -p MemoryCurrent -p MainPID` key=value output. */
function parseSystemdShow(stdout: string): UnitRuntime {
  let mainPid = 0;
  let memBytes: number | null = null;
  for (const line of stdout.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1).trim();
    if (key === "MainPID") {
      const pid = Number.parseInt(value, 10);
      mainPid = Number.isFinite(pid) ? pid : 0;
    } else if (key === "MemoryCurrent") {
      if (value === SYSTEMD_MEMORY_NOT_SET || value === "") {
        memBytes = null;
      } else {
        const bytes = Number.parseInt(value, 10);
        memBytes = Number.isFinite(bytes) ? bytes : null;
      }
    }
  }
  return { mainPid, memBytes };
}

/**
 * Whitelist for unit/container names handed to privileged exec. systemctl and
 * docker name grammar is a subset of this; anything outside is rejected
 * before it ever reaches an argv array (defense in depth — argv is fixed and
 * shell-free already).
 */
const SAFE_NAME_RE = /^[A-Za-z0-9_.@-]+$/;

/** Raw snake_case catalog row as node-postgres returns it. */
interface CatalogRow extends Record<string, unknown> {
  id: number;
  slug: string;
  name: string;
  kind: string;
  category: string;
  description: string | null;
  health_url: string;
  health_type: string;
  open_url: string;
  env_source: string | null;
  status: string;
  last_check_at: Date | string | null;
  response_ms: number | null;
  uptime_24h: string | null;
  icon_type: string | null;
  icon_color: string | null;
  icon_image: string | null;
  sort_order: number;
  is_active: boolean;
  has_webui: boolean;
  show_in_healthcheck: boolean;
  show_in_webui: boolean;
  autostart: boolean;
  unit_name: string | null;
  container_names: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

/**
 * Fold a raw catalog row into the contract ServiceRecord shape (flat icon
 * columns → nested `icon` object; badges unknown here → empty list, matching a
 * catalog row with no badge rows).
 */
function serviceRecordFromRow(row: CatalogRow): ServiceRecord {
  let lastCheckAt = row.last_check_at;
  if (!(lastCheckAt instanceof Date) && lastCheckAt !== null) {
    lastCheckAt = new Date(lastCheckAt);
  }
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    kind: row.kind,
    category: row.category,
    description: row.description,
    healthUrl: row.health_url,
    healthType: row.health_type,
    openUrl: row.open_url,
    envSource: row.env_source,
    status: row.status,
    lastCheckAt,
    responseMs: row.response_ms,
    uptime24h: row.uptime_24h,
    sortOrder: row.sort_order,
    isActive: row.is_active,
    hasWebui: row.has_webui,
    showInHealthcheck: row.show_in_healthcheck,
    showInWebui: row.show_in_webui,
    autostart: row.autostart,
    unitName: row.unit_name,
    containerNames: row.container_names,
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at),
    icon: { type: row.icon_type ?? "auto", color: row.icon_color, image: row.icon_image },
    badges: [],
  };
}

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const slugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "slug must be lowercase kebab-case");

const setEdgeInput = z
  .object({
    sourceSlug: slugSchema,
    targetSlug: slugSchema,
    kind: z.enum(["configured", "observed"]).default("configured"),
    detail: z.string().max(512).nullable().optional(),
  })
  .strict();

const removeEdgeInput = z
  .object({
    sourceSlug: slugSchema,
    targetSlug: slugSchema,
    kind: z.enum(["configured", "observed"]).default("configured"),
  })
  .strict();

const setAutostartInput = z
  .object({
    slug: slugSchema,
    enabled: z.boolean(),
    /** Bypass the active-dependents preflight (still approval-gated). */
    force: z.boolean().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// listDependencies — GET, any authenticated user
// ---------------------------------------------------------------------------

const listDependenciesGate = defineServerFn({
  method: "GET",
  auth: "any",
  input: z.object({}).strict(),
  rateLimit: { limit: 60, windowSec: 60, bucket: "user" },
  surface: "dependencies",
  action: "dependencies.list",
  handler: async (): Promise<DependenciesPayload> => {
    const deps = await resolveDeps();
    const db = deps.db();
    const { sql } = await import("drizzle-orm");

    // Full catalog (active only — inactive rows are hidden catalog-wide) and
    // every dependency edge, in parallel. Raw SQL so the graph payload carries
    // the Phase-2 columns in one round trip; `serviceRecordFromRow` folds it
    // into the same ServiceRecord shape listServices() returns.
    const [catalog, edgeResult] = (await Promise.all([
      db.execute(
        sql`SELECT id, slug, name, kind, category, description, health_url, health_type,
                   open_url, env_source, status, last_check_at, response_ms, uptime_24h,
                   icon_type, icon_color, icon_image, sort_order, is_active, has_webui,
                   show_in_healthcheck, show_in_webui, autostart, unit_name, container_names,
                   created_at, updated_at
            FROM services
            WHERE is_active = true
            ORDER BY category, sort_order, name`,
      ),
      db.execute(
        sql`SELECT id, source_slug, target_slug, kind, source, detail, last_seen_at, created_at
            FROM service_dependencies
            ORDER BY source_slug, target_slug`,
      ),
    ])) as unknown as [{ rows: CatalogRow[] }, { rows: EdgeRow[] }];
    const edges: DependencyEdge[] = edgeResult.rows.map(edgeFromRow);

    // Collect the unique runtime backends needed across all nodes, then probe
    // each backend once (one docker stats call covers every container).
    const unitNames = new Set<string>();
    const containerNames = new Set<string>();
    for (const row of catalog.rows) {
      if (row.unit_name) unitNames.add(row.unit_name);
      for (const name of parseContainerNames(row.container_names) ?? []) {
        containerNames.add(name);
      }
    }

    // docker stats: single snapshot for all containers (empty → skip the call).
    let dockerStats = new Map<string, { memBytes: number | null; cpuPct: number | null }>();
    if (containerNames.size > 0) {
      const statsRes = await deps.exec("docker", ["stats", "--no-stream", "--format", "json"]);
      if (statsRes.exitCode === 0) dockerStats = parseDockerStatsJson(statsRes.stdout);
    }

    // systemd: one `show` per unit, parallel, bounded by the small catalog.
    const unitRuntime = new Map<string, UnitRuntime>();
    await Promise.all(
      [...unitNames].map(async (unit) => {
        const res = await deps.exec("systemctl", [
          "show",
          "-p",
          "MemoryCurrent",
          "-p",
          "MainPID",
          unit,
        ]);
        if (res.exitCode === 0) unitRuntime.set(unit, parseSystemdShow(res.stdout));
      }),
    );

    // dependents[provider] = consumers of that provider
    const dependentsByTarget = new Map<string, string[]>();
    for (const edge of edges) {
      const list = dependentsByTarget.get(edge.targetSlug);
      if (list) {
        if (!list.includes(edge.sourceSlug)) list.push(edge.sourceSlug);
      } else {
        dependentsByTarget.set(edge.targetSlug, [edge.sourceSlug]);
      }
    }

    const nodes: ServiceNodeInfo[] = catalog.rows.map((row) => {
      const names = parseContainerNames(row.container_names);
      let running = false;
      let memBytes: number | null = null;
      let cpuPct: number | null = null;

      if (row.unit_name) {
        const rt = unitRuntime.get(row.unit_name);
        if (rt) {
          if (rt.mainPid > 0) running = true;
          memBytes = rt.memBytes;
        }
      }
      if (names) {
        for (const name of names) {
          const stat = dockerStats.get(name);
          if (stat) {
            running = true; // present in docker stats → container is up
            if (stat.memBytes !== null) memBytes = (memBytes ?? 0) + stat.memBytes;
            if (stat.cpuPct !== null) cpuPct = (cpuPct ?? 0) + stat.cpuPct;
          }
        }
      }

      return {
        ...serviceRecordFromRow(row),
        autostart: row.autostart,
        unitName: row.unit_name,
        containerNames: names,
        running,
        memBytes,
        cpuPct,
        dependents: dependentsByTarget.get(row.slug) ?? [],
      };
    });

    return { nodes, edges };
  },
});

export const listDependencies = createServerFn({ method: "GET" })
  .middleware([listDependenciesGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
// scanDependenciesNow — POST, admin, read-only scan (no approval needed)
// ---------------------------------------------------------------------------

const scanDependenciesNowGate = defineServerFn({
  method: "POST",
  auth: "admin",
  input: z.object({}).strict(),
  rateLimit: { limit: 6, windowSec: 60, bucket: "user" },
  surface: "dependencies",
  action: "dependencies.scan",
  handler: async (): Promise<ScanResult> => {
    const deps = await resolveDeps();
    return deps.scan();
  },
});

export const scanDependenciesNow = createServerFn({ method: "POST" })
  .middleware([scanDependenciesNowGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
// setDependencyEdge — POST, admin, manual edges only
// ---------------------------------------------------------------------------

const setDependencyEdgeGate = defineServerFn({
  method: "POST",
  auth: "admin",
  input: setEdgeInput,
  rateLimit: { limit: 30, windowSec: 60, bucket: "user" },
  surface: "dependencies",
  action: "dependencies.setEdge",
  handler: async ({ input }): Promise<DependencyEdge> => {
    const deps = await resolveDeps();
    const db = deps.db();
    const { sql } = await import("drizzle-orm");
    const { validationError, notFoundError } = await import("@/server/errors/types");

    if (input.sourceSlug === input.targetSlug) {
      throw validationError("a service cannot depend on itself", [
        { field: "targetSlug", message: "source and target must differ" },
      ]);
    }

    // Both slugs must exist in the catalog (FK-lite: edges reference slugs).
    const catalog = (await db.execute(
      sql`SELECT slug FROM services WHERE slug IN (${input.sourceSlug}, ${input.targetSlug})`,
    )) as { rows: { slug: string }[] };
    const known = new Set(catalog.rows.map((r) => r.slug));
    if (!known.has(input.sourceSlug)) throw notFoundError(`service ${input.sourceSlug}`);
    if (!known.has(input.targetSlug)) throw notFoundError(`service ${input.targetSlug}`);

    // Upsert keyed by the unique constraint. The WHERE source='manual' guard
    // protects seed/detected rows: if the (slug, slug, kind) triple already
    // exists under another source, zero rows come back → reject.
    const result = (await db.execute(
      sql`INSERT INTO service_dependencies (source_slug, target_slug, kind, source, detail, last_seen_at)
          VALUES (${input.sourceSlug}, ${input.targetSlug}, ${input.kind}, 'manual',
                  ${input.detail ?? null}, now())
          ON CONFLICT (source_slug, target_slug, kind)
          DO UPDATE SET detail = EXCLUDED.detail, last_seen_at = now()
          WHERE service_dependencies.source = 'manual'
          RETURNING id, source_slug, target_slug, kind, source, detail, last_seen_at, created_at`,
    )) as { rows: EdgeRow[] };
    const row = result.rows[0];
    if (!row) {
      throw validationError(
        `edge ${input.sourceSlug} → ${input.targetSlug} (${input.kind}) is managed by the scanner; only manual edges are editable`,
      );
    }
    return edgeFromRow(row);
  },
});

export const setDependencyEdge = createServerFn({ method: "POST" })
  .middleware([setDependencyEdgeGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
// removeDependencyEdge — POST, admin, manual edges only
// ---------------------------------------------------------------------------

const removeDependencyEdgeGate = defineServerFn({
  method: "POST",
  auth: "admin",
  input: removeEdgeInput,
  rateLimit: { limit: 30, windowSec: 60, bucket: "user" },
  surface: "dependencies",
  action: "dependencies.removeEdge",
  handler: async ({ input }): Promise<{ removed: boolean }> => {
    const deps = await resolveDeps();
    const db = deps.db();
    const { sql } = await import("drizzle-orm");
    const { validationError, notFoundError } = await import("@/server/errors/types");

    // Look the edge up first so we can distinguish "never existed" (404) from
    // "exists but is scanner-managed" (400).
    const existing = (await db.execute(
      sql`SELECT id, source FROM service_dependencies
          WHERE source_slug = ${input.sourceSlug}
            AND target_slug = ${input.targetSlug}
            AND kind = ${input.kind}
          LIMIT 1`,
    )) as { rows: { id: number; source: string }[] };
    const row = existing.rows[0];
    if (!row) {
      throw notFoundError(`edge ${input.sourceSlug} → ${input.targetSlug} (${input.kind})`);
    }
    if (row.source !== "manual") {
      throw validationError("only manual dependency edges can be removed");
    }
    await db.execute(sql`DELETE FROM service_dependencies WHERE id = ${row.id}`);
    return { removed: true };
  },
});

export const removeDependencyEdge = createServerFn({ method: "POST" })
  .middleware([removeDependencyEdgeGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
// setServiceAutostart — POST, admin, approval-gated ("services.autostart")
// ---------------------------------------------------------------------------

const setServiceAutostartGate = defineServerFn({
  method: "POST",
  auth: "admin",
  input: setAutostartInput,
  rateLimit: { limit: 10, windowSec: 60, bucket: "user" },
  surface: "services",
  action: "services.autostart",
  target: (input) => input.slug,
  approval: true,
  handler: async ({ input }): Promise<AutostartResult> => {
    const deps = await resolveDeps();
    const db = deps.db();
    const { sql } = await import("drizzle-orm");
    const { notFoundError, conflictError, validationError } = await import("@/server/errors/types");

    const service = (await db.execute(
      sql`SELECT slug, autostart, unit_name, container_names FROM services WHERE slug = ${input.slug} LIMIT 1`,
    )) as {
      rows: {
        slug: string;
        autostart: boolean;
        unit_name: string | null;
        container_names: string | null;
      }[];
    };
    const row = service.rows[0];
    if (!row) throw notFoundError(`service ${input.slug}`);

    const names = parseContainerNames(row.container_names);

    // Preflight: disabling a provider that has active, autostarting dependents
    // breaks them on next boot/restart → 409 unless the caller forced it
    // (force is covered by the approval mint payload).
    if (input.enabled === false && !input.force) {
      const active = (await db.execute(
        sql`SELECT DISTINCT d.source_slug
            FROM service_dependencies d
            JOIN services s ON s.slug = d.source_slug
            WHERE d.target_slug = ${input.slug}
              AND s.is_active = true
              AND s.autostart = true
            ORDER BY d.source_slug`,
      )) as { rows: { source_slug: string }[] };
      const dependents = active.rows.map((r) => r.source_slug);
      if (dependents.length > 0) {
        throw conflictError(
          `disabling ${input.slug} would strand ${dependents.length} active dependent service(s)`,
          { blocked: true, dependents },
        );
      }
    }

    const backends: AutostartBackendStatus = { systemd: null, docker: null, errors: [] };

    // Validate every name BEFORE running anything (never trust the DB blindly).
    if (row.unit_name !== null && !SAFE_NAME_RE.test(row.unit_name)) {
      throw validationError(
        `refusing to operate on unsafe unit name ${JSON.stringify(row.unit_name)}`,
      );
    }
    for (const name of names ?? []) {
      if (!SAFE_NAME_RE.test(name)) {
        throw validationError(
          `refusing to operate on unsafe container name ${JSON.stringify(name)}`,
        );
      }
    }

    // systemd backend
    if (row.unit_name !== null) {
      const verb = input.enabled ? "enable" : "disable";
      const res = await deps.exec("systemctl", [verb, "--now", row.unit_name]);
      if (res.exitCode === 0) {
        backends.systemd = "ok";
      } else {
        backends.systemd = "failed";
        backends.errors.push(
          `systemctl ${verb} --now ${row.unit_name}: ${res.stderr.trim() || `exit ${res.exitCode}`}`,
        );
      }
    }

    // docker backend — restart policy first, then the state transition.
    if (names !== null && names.length > 0) {
      let dockerOk = true;
      for (const name of names) {
        if (input.enabled) {
          const policy = await deps.exec("docker", ["update", "--restart=unless-stopped", name]);
          if (policy.exitCode !== 0) {
            dockerOk = false;
            backends.errors.push(
              `docker update --restart=unless-stopped ${name}: ${policy.stderr.trim() || `exit ${policy.exitCode}`}`,
            );
            continue;
          }
          const start = await deps.exec("docker", ["start", name]);
          if (start.exitCode !== 0) {
            dockerOk = false;
            backends.errors.push(
              `docker start ${name}: ${start.stderr.trim() || `exit ${start.exitCode}`}`,
            );
          }
        } else {
          const policy = await deps.exec("docker", ["update", "--restart=no", name]);
          if (policy.exitCode !== 0) {
            dockerOk = false;
            backends.errors.push(
              `docker update --restart=no ${name}: ${policy.stderr.trim() || `exit ${policy.exitCode}`}`,
            );
            continue;
          }
          const stop = await deps.exec("docker", ["stop", name]);
          if (stop.exitCode !== 0) {
            dockerOk = false;
            backends.errors.push(
              `docker stop ${name}: ${stop.stderr.trim() || `exit ${stop.exitCode}`}`,
            );
          }
        }
      }
      backends.docker = dockerOk ? "ok" : "failed";
    }

    // Partial failure: do NOT persist autostart; report which half failed so
    // the UI can show the exact backend error (row stays consistent).
    if (backends.errors.length > 0) {
      const { systemError } = await import("@/server/errors/types");
      throw systemError(
        `autostart ${input.enabled ? "enable" : "disable"} partially failed for ${input.slug}`,
        { slug: input.slug, backends },
      );
    }

    await db.execute(
      sql`UPDATE services SET autostart = ${input.enabled}, updated_at = now() WHERE slug = ${input.slug}`,
    );

    return { ok: true, slug: input.slug, enabled: input.enabled, backends };
  },
});

export const setServiceAutostart = createServerFn({ method: "POST" })
  .middleware([setServiceAutostartGate])
  .handler(serverFnNoop);
