/**
 * Health-check scheduler.
 *
 * The dashboard runs as a long-lived Node process (the systemd
 * `cortex-dashboard.service`). The server framework has no built-in
 * background loop, so without this every service in the catalog sits at
 * `status = 'unknown'` — the manual recheck server fn only probes on an
 * explicit request.
 *
 * This module starts ONE process-wide interval (guarded by a module
 * singleton) that probes every active service by its `health_type`,
 * updates the catalog row (`status`, `responseMs`, `lastCheckAt`), and
 * appends a `service_health_log` row. It is started once per server boot
 * from `src/server/runtime.ts` (`bootRuntime`).
 *
 * Probes are intentionally simple and read-only:
 *   http    → GET the health_url; 2xx/3xx (and 401/403) = online
 *   tcp     → open a socket to host:port (parsed from health_url, or a
 *             well-known default port for standard databases)
 *   systemd → `systemctl is-active <unit>` (tries <slug> and cortex-<slug>)
 *   docker  → `docker inspect -f '{{.State.Running}}' <name>` (tries
 *             <slug> and cortex-<slug>)
 *   process → systemd unit first, then `pgrep -f <slug>`
 *   none    → left unknown
 *
 * Non-http probes shell out via execFile (no shell, fixed argv). On a
 * non-root / non-Linux host (dev, CI) they simply fail closed to
 * 'unknown'/'offline' — they never throw out of the scheduler.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { connect } from "node:net";
import { sql } from "drizzle-orm";
import { runSequentiallyUntil } from "@/lib/sequential";
import { getDb } from "../db/client";
import { listServices, updateService } from "../db/repos/services";
import { serviceHealthLog } from "../db/schema";

const execFileAsync = promisify(execFile);

/** How often to sweep the whole catalog. */
const INTERVAL_MS = 60_000;
/** Per-probe wall-clock cap. */
const PROBE_TIMEOUT_MS = 8_000;
/** Max probes in flight at once (the catalog is ~50 rows). */
const CONCURRENCY = 8;

export type ProbeStatus = "online" | "offline" | "unknown";

export interface ProbeResult {
  status: ProbeStatus;
  responseMs: number | null;
}

interface CatalogRow {
  id: number;
  slug: string;
  healthType: string;
  healthUrl: string | null;
}

/** Well-known TCP ports for catalog DBs that carry no explicit target. */
const TCP_DEFAULT_PORTS: Record<string, number> = {
  postgresql: 5432,
  mysql: 3306,
  mariadb: 3306,
  mongodb: 27017,
  redis: 6379,
};

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

async function probeHttp(url: string): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const start = Date.now();
  try {
    const res = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: { "User-Agent": "CortexOS-HealthBot/1.0" },
      redirect: "manual",
    });
    const ms = Date.now() - start;
    // 2xx/3xx = the service answered. 401/403 = it answered but is
    // behind auth (e.g. mongo-express basic-auth) — still "up". Only
    // 404/5xx/network failures count as offline.
    const ok = (res.status >= 200 && res.status < 400) || res.status === 401 || res.status === 403;
    return { status: ok ? "online" : "offline", responseMs: ms };
  } catch {
    return { status: "offline", responseMs: null };
  } finally {
    clearTimeout(timer);
  }
}

function probeTcp(host: string, port: number): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = connect({ host, port });
    const done = (status: ProbeStatus) => {
      socket.destroy();
      resolve({ status, responseMs: status === "online" ? Date.now() - start : null });
    };
    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.once("connect", () => done("online"));
    socket.once("timeout", () => done("offline"));
    socket.once("error", () => done("offline"));
  });
}

async function probeSystemd(slug: string, explicit = false): Promise<ProbeResult> {
  const units = explicit ? [slug] : [slug, `cortex-${slug}`, `${slug}.service`];
  const found = await runSequentiallyUntil(
    units,
    async (unit): Promise<ProbeResult | undefined> => {
      try {
        const { stdout } = await execFileAsync("systemctl", ["is-active", unit], {
          timeout: PROBE_TIMEOUT_MS,
        });
        if (stdout.trim() === "active") return { status: "online", responseMs: null };
      } catch {
        // is-active exits non-zero when not active; try the next name.
      }
      return undefined;
    },
    (r): r is ProbeResult => r !== undefined,
  );
  return found ?? { status: "offline", responseMs: null };
}

async function probeDocker(slug: string, explicit = false): Promise<ProbeResult> {
  const names = explicit ? [slug] : [slug, `cortex-${slug}`];
  const found = await runSequentiallyUntil(
    names,
    async (name): Promise<ProbeResult | undefined> => {
      try {
        const { stdout } = await execFileAsync(
          "docker",
          ["inspect", "-f", "{{.State.Running}}", name],
          { timeout: PROBE_TIMEOUT_MS },
        );
        if (stdout.trim() === "true") return { status: "online", responseMs: null };
        if (stdout.trim() === "false") return { status: "offline", responseMs: null };
      } catch {
        // no such container under this name; try the next.
      }
      return undefined;
    },
    (r): r is ProbeResult => r !== undefined,
  );
  return found ?? { status: "offline", responseMs: null };
}

async function probeProcess(slug: string): Promise<ProbeResult> {
  // Prefer a matching systemd unit (most CortexOS "process" entries are
  // actually units); fall back to pgrep on the slug.
  const viaSystemd = await probeSystemd(slug);
  if (viaSystemd.status === "online") return viaSystemd;
  try {
    await execFileAsync("pgrep", ["-f", slug], { timeout: PROBE_TIMEOUT_MS });
    return { status: "online", responseMs: null };
  } catch {
    return { status: "offline", responseMs: null };
  }
}

function tcpTargetFor(row: CatalogRow): { host: string; port: number } | null {
  const url = row.healthUrl ?? "";
  const m = url.match(/^(?:tcp:\/\/)?([^:/#]+):(\d+)/);
  if (m) return { host: m[1], port: Number(m[2]) };
  const port = TCP_DEFAULT_PORTS[row.slug];
  if (port) return { host: "127.0.0.1", port };
  return null;
}

/**
 * Probe a single catalog row by its `healthType`. Exported so the manual
 * recheck server fn can reuse the exact same probe logic the scheduler uses.
 */
export async function probe(row: CatalogRow): Promise<ProbeResult> {
  const target = row.healthUrl?.trim();
  const explicitTarget = target && target !== "#" ? target : null;
  if (explicitTarget && (row.healthType === "systemd" || row.healthType === "docker") &&
      !/^[A-Za-z0-9][A-Za-z0-9_.@:-]*$/.test(explicitTarget)) {
    return { status: "unknown", responseMs: null };
  }
  switch (row.healthType) {
    case "http": {
      const url = row.healthUrl ?? "";
      if (!url.startsWith("http")) return { status: "unknown", responseMs: null };
      return probeHttp(url);
    }
    case "tcp": {
      const t = tcpTargetFor(row);
      return t ? probeTcp(t.host, t.port) : { status: "unknown", responseMs: null };
    }
    case "systemd":
      return probeSystemd(explicitTarget ?? row.slug, explicitTarget !== null);
    case "docker":
      return probeDocker(explicitTarget ?? row.slug, explicitTarget !== null);
    case "process":
      return probeProcess(row.slug);
    default:
      return { status: "unknown", responseMs: null };
  }
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

async function persist(row: CatalogRow, result: ProbeResult): Promise<void> {
  const db = getDb();
  await updateService(db, row.id, {
    status: result.status,
    responseMs: result.responseMs,
    lastCheckAt: new Date(),
  });
  try {
    await db.insert(serviceHealthLog).values({
      serviceId: row.id,
      status: result.status,
      responseTimeMs: result.responseMs ?? null,
      checkedAt: new Date(),
    });
  } catch {
    // snapshot logging is best-effort; the catalog row is the source of truth.
  }
}

/** Run a bounded-concurrency pool over `items`. */
async function pool<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let i = 0;
  async function runNext(): Promise<void> {
    if (i >= items.length) {
      return;
    }
    const item = items[i];
    i += 1;
    await worker(item);
    await runNext();
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runNext()));
}

let sweeping = false;

/** Probe every active service once and persist the results. */
export async function sweepOnce(): Promise<{ checked: number }> {
  if (sweeping) return { checked: 0 };
  sweeping = true;
  try {
    const db = getDb();
    const { rows } = await listServices(db, { activeOnly: true, pageSize: 500 });
    const catalog = rows as unknown as CatalogRow[];
    await pool(catalog, CONCURRENCY, async (row) => {
      try {
        const result = await probe(row);
        await persist(row, result);
      } catch {
        // never let one bad row abort the sweep
      }
    });
    // Prune rows older than 7 days. The retention index makes this fast.
    // Guard: a prune failure must not abort the sweep or surface to callers.
    try {
      await db
        .delete(serviceHealthLog)
        .where(sql`${serviceHealthLog.checkedAt} < NOW() - INTERVAL '7 days'`);
    } catch (err) {
      console.error("[health-scheduler] prune service_health_log failed:", err);
    }
    return { checked: catalog.length };
  } finally {
    sweeping = false;
  }
}

// ---------------------------------------------------------------------------
// Lifecycle (process singleton)
// ---------------------------------------------------------------------------

let started = false;

/** Start the periodic sweep. Idempotent — safe to call from `bootRuntime`. */
export function startHealthScheduler(): void {
  if (started) return;
  started = true;
  // Kick an immediate sweep so statuses populate within seconds of boot,
  // then settle into the interval. Errors are swallowed — the scheduler
  // must never crash the server.
  sweepOnce().catch(() => {});
  const timer = setInterval(() => {
    sweepOnce().catch(() => {});
  }, INTERVAL_MS);
  // Don't keep the event loop alive solely for the timer.
  if (typeof timer.unref === "function") timer.unref();
}
