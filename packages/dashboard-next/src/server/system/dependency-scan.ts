/**
 * Dependency scanner — derives service-dependency edges from static config
 * and live sockets, then upserts them into `service_dependencies`.
 *
 * Two edge classes:
 *   - kind='configured', source='detected': parsed from stacks/* compose
 *     files (`depends_on` entries, service-level service refs, and env
 *     values pointing at known host ports / hostnames).
 *   - kind='observed', source='detected': live TCP sockets from `ss -tnp`.
 *     LISTEN rows identify providers by port; ESTABLISHED rows identify
 *     consumers via their owning pid (container pids resolved through
 *     `docker inspect`).
 *
 * Privilege model mirrors src/server/system/systemd.ts: execFile with fixed
 * argv arrays, never a shell. Every exec failure degrades to the
 * configured-only edge set — scanDependencies never throws on probe
 * failure. Probe/parse work is dependency-injected through
 * `setScanDepsForTests` so tests stay Linux-agnostic.
 *
 * DB writes go through the shared client (`@/server/db/client`) with a
 * single raw INSERT … ON CONFLICT (source_slug, target_slug, kind). Rows
 * whose source is 'seed' or 'manual' are NEVER mutated — the DO UPDATE
 * carries WHERE source NOT IN ('seed','manual'), so a conflicting
 * protected row counts as zero affected rows.
 *
 * Absence of an edge NEVER proves a service unused: edges only record
 * what config + live sockets could prove.
 */

import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { stringify } from "yaml";

import { sql } from "drizzle-orm";

import { db } from "@/server/db/client";
import { dashboardPaths, isWithinRoot } from "@/server/paths";

const execFileAsync = promisify(execFile);

export interface ScannedEdge {
  source_slug: string;
  target_slug: string;
  kind: "configured" | "observed";
  source: "seed" | "detected" | "manual";
  detail: string;
}

export interface ScanResult {
  /** Rows actually inserted/updated by the upsert (protected conflicts count 0). */
  upserted: number;
  /** Deduped edges the scan produced (whether or not the upsert touched them). */
  edges: ScannedEdge[];
}

// ---------------------------------------------------------------------------
// Static catalog maps — host port / hostname / compose service name → slug.
// Keep in sync with the services catalog (docs/SERVICES.md).
// ---------------------------------------------------------------------------

export const PORT_TO_SLUG: Record<number, string> = {
  11434: "ollama",
  20128: "durindoor",
  3080: "dashboard",
  9000: "whisper",
  8096: "jellyfin",
  8124: "home-assistant",
  3420: "dockhand",
  4007: "postiz",
  3035: "langfuse",
  8091: "sandbox-runner",
  3333: "kernel-browser",
  8888: "hindsight", // hindsight-api
  5432: "postgresql",
  6379: "redis",
  3306: "mysql",
  27017: "mongodb",
  9090: "prometheus",
  3000: "grafana",
  3100: "loki",
  9187: "pg-exporter",
  9121: "redis-exporter",
  9104: "mysql-exporter",
  9216: "mongo-exporter",
  3002: "firecrawl",
  2020: "fluent-bit",
  8085: "cadvisor",
  9100: "node-exporter",
  5050: "pgadmin",
  5540: "redisinsight",
  8086: "phpmyadmin",
  8087: "mongo-express",
};

export const HOSTNAME_TO_SLUG: Record<string, string> = {
  dashboard: "dashboard",
  ollama: "ollama",
  postiz: "postiz",
  langfuse: "langfuse",
  hermes: "hermes",
  openclaw: "openclaw",
  "mail-guardian": "mail-guardian",
  "fluent-bit": "fluent-bit",
  "kernel-browser": "kernel-browser",
  durindoor: "durindoor",
  "9router": "durindoor",
  hindsight: "hindsight",
  "hindsight-api": "hindsight",
  postgresql: "postgresql",
  postgres: "postgresql",
  redis: "redis",
  mysql: "mysql",
  mariadb: "mysql",
  mongodb: "mongodb",
  mongo: "mongodb",
  prometheus: "prometheus",
  grafana: "grafana",
  loki: "loki",
  "pg-exporter": "pg-exporter",
  "redis-exporter": "redis-exporter",
  "mysql-exporter": "mysql-exporter",
  "mongo-exporter": "mongo-exporter",
  firecrawl: "firecrawl",
  "firecrawl-api": "firecrawl",
  "firecrawl-redis": "firecrawl", // private infra, folded into the firecrawl node
  "firecrawl-rabbitmq": "firecrawl",
  "firecrawl-postgres": "firecrawl",
  "firecrawl-playwright": "firecrawl",
  "nuq-postgres": "firecrawl",
  rabbitmq: "firecrawl",
  "playwright-service": "firecrawl",
  cadvisor: "cadvisor",
  "node-exporter": "node-exporter",
  jellyfin: "jellyfin",
  "home-assistant": "home-assistant",
  whisper: "whisper",
  "sandbox-runner": "sandbox-runner",
  dockhand: "dockhand",
  pgadmin: "pgadmin",
  redisinsight: "redisinsight",
  "redis-insight": "redisinsight",
  phpmyadmin: "phpmyadmin",
  "mongo-express": "mongo-express",
};

// ---------------------------------------------------------------------------
// Container name → slug (for ss pid attribution). Self-services included:
// self-edges are filtered at emission time, not here.
// ---------------------------------------------------------------------------

// Container names double as env hostnames on shared docker networks, so the
// full inventory joins the hostname map (used for env refs AND consumer
// attribution via `container_name`).
const CONTAINER_TO_SLUG: Record<string, string> = {
  "cortex-postgresql": "postgresql",
  "cortex-redis": "redis",
  "cortex-mysql": "mysql",
  "cortex-mongodb": "mongodb",
  "cortex-prometheus": "prometheus",
  "cortex-grafana": "grafana",
  "cortex-loki": "loki",
  "cortex-pg-exporter": "pg-exporter",
  "cortex-redis-exporter": "redis-exporter",
  "cortex-mysql-exporter": "mysql-exporter",
  "cortex-cadvisor": "cadvisor",
  "cortex-node-exporter": "node-exporter",
  "cortex-jellyfin": "jellyfin",
  "cortex-home-assistant": "home-assistant",
  "cortex-whisper": "whisper",
  "cortex-sandbox-runner": "sandbox-runner",
  "cortex-dockhand": "dockhand",
  "cortex-pgadmin": "pgadmin",
  "cortex-redisinsight": "redisinsight",
  "cortex-phpmyadmin": "phpmyadmin",
  "cortex-mongo-express": "mongo-express",
  "hindsight-api": "hindsight",
  "firecrawl-api": "firecrawl",
  "firecrawl-redis": "firecrawl",
  "firecrawl-rabbitmq": "firecrawl",
  "firecrawl-postgres": "firecrawl",
  "firecrawl-playwright": "firecrawl",
};

for (const slug of Object.values(HOSTNAME_TO_SLUG)) {
  CONTAINER_TO_SLUG[`cortex-${slug}`] ??= slug;
}

for (const [name, slug] of Object.entries(CONTAINER_TO_SLUG)) {
  HOSTNAME_TO_SLUG[`cortex-${slug}`] ??= slug;
  HOSTNAME_TO_SLUG[name] ??= slug;
}

// ---------------------------------------------------------------------------
// Probe seam — everything that touches the host goes through here so tests
// can inject fixtures without a Linux/docker environment.
// ---------------------------------------------------------------------------

export interface ScanDeps {
  exec: (
    file: string,
    args: readonly string[],
    options?: { timeout?: number; maxBuffer?: number },
  ) => Promise<{ stdout: string; stderr: string }>;
  readComposeFiles: () => Promise<{ path: string; content: string }[]>;
}

// Read-only host probes only. Fixed argv (no shell), and the binary itself is
// allowlisted so this can never become an arbitrary command runner — the same
// safety invariant as systemd.ts's execPrivileged (Phase 2: scanner needs `ss`
// which is not in that bridge's 2-binary allowlist, so it runs here under an
// equivalent pinned-binary guard rather than widening the mutating bridge).
const SCAN_ALLOWED_BINARIES: Record<string, true> = {
  "/usr/bin/ss": true,
  "/usr/bin/docker": true,
};
const realExec: ScanDeps["exec"] = async (file, args, options) => {
  if (!SCAN_ALLOWED_BINARIES[file]) {
    throw new Error(`dependency-scan: refusing to exec non-allowlisted binary '${file}'`);
  }
  const { stdout, stderr } = await execFileAsync(file, [...args], {
    timeout: options?.timeout ?? 10_000,
    maxBuffer: options?.maxBuffer ?? 4 * 1024 * 1024,
  });
  return { stdout: stdout ?? "", stderr: stderr ?? "" };
};

async function readComposeFilesFromDisk(): Promise<{ path: string; content: string }[]> {
  const paths = dashboardPaths();
  const files: { path: string; content: string }[] = [];
  const root = await realpath(paths.root);
  const catalog = JSON.parse(await readFile(resolve(root, "catalog/services.json"), "utf8")) as {
    services: { id: string; recipe?: string }[];
  };
  const installed = await db.execute(sql`SELECT slug FROM services`);
  const selected = new Set(installed.rows.map((row) => String(row.slug)));
  for (const service of catalog.services) {
    if (!selected.has(service.id) || !service.recipe?.endsWith(".json")) continue;
    try {
      const recipe = await realpath(resolve(root, service.recipe));
      if (!isWithinRoot(recipe, root)) continue;
      const compose = JSON.parse(await readFile(recipe, "utf8"));
      if (!compose.services || typeof compose.services !== "object") continue;
      // Source recipes contain no credentials; never inspect rendered private files.
      files.push({
        path: `${service.id}/docker-compose.yml`,
        content: stringify(compose),
      });
    } catch {
      // One unavailable optional recipe must not discard other configured edges.
    }
  }
  return files;
}

let deps: ScanDeps = { exec: realExec, readComposeFiles: readComposeFilesFromDisk };

/** Test helper: swap the probe layer. Pass `null` to restore the real probes. */
export function setScanDepsForTests(next: ScanDeps | null): void {
  deps = next ?? { exec: realExec, readComposeFiles: readComposeFilesFromDisk };
}

// ---------------------------------------------------------------------------
// Parsing — pure functions, exported for direct unit tests.
// ---------------------------------------------------------------------------

interface RawEdge {
  source_slug: string;
  target_slug: string;
  detail: string;
}

function normalizeHostname(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  // Exact map hits short-circuit (also protects slug ids like "memory-os"
  // from the host:port splitting below).
  if (HOSTNAME_TO_SLUG[trimmed]) return trimmed;
  // Strip scheme + port + path: "http://host:5432/x" → "host"
  const hostish = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").split(/[/:@]/)[0];
  if (!hostish || hostish === "localhost" || hostish === "127.0.0.1" || hostish === "0.0.0.0") {
    return null;
  }
  return hostish;
}

function slugForHostname(host: string): string | null {
  const normalized = normalizeHostname(host);
  if (!normalized) return null;
  return HOSTNAME_TO_SLUG[normalized] ?? null;
}

/** Ports referenced in env values map to providers, e.g. `REDIS_URL=redis://host:6379/0`. */
const ENV_PORT_RE = /[:/](\d{2,5})(?=[/?#"'&\s]|$)/g;

function envValueToSlugs(value: string): string[] {
  const slugs = new Set<string>();
  const host = slugForHostname(value);
  if (host) slugs.add(host);
  for (const match of value.matchAll(ENV_PORT_RE)) {
    const port = Number(match[1]);
    const slug = PORT_TO_SLUG[port];
    if (slug) slugs.add(slug);
  }
  return [...slugs];
}

/**
 * Indentation-driven YAML subset parser for compose files (no yaml dep in
 * this package). Understands the shapes our stacks use: nested maps,
 * `key: value` scalars, `- item` lists, and block scalars (`|`, `>`).
 * Comments and blank lines are skipped; quoted scalars are unquoted.
 */
function parseComposeServices(content: string): Record<string, Record<string, unknown>> {
  type Frame =
    | { kind: "map"; indent: number; value: Record<string, unknown> }
    | { kind: "pending"; indent: number; parent: Record<string, unknown>; key: string }
    | { kind: "list"; indent: number; value: unknown[] };

  const root: Record<string, unknown> = {};
  const stack: Frame[] = [{ kind: "map", indent: -1, value: root }];

  const parseScalar = (raw: string): unknown => {
    let v = raw.trim();
    if (!v) return {};
    if (
      (v.startsWith('"') && v.endsWith('"') && v.length >= 2) ||
      (v.startsWith("'") && v.endsWith("'") && v.length >= 2)
    ) {
      v = v.slice(1, -1);
    }
    if (v === "true") return true;
    if (v === "false") return false;
    return v;
  };

  for (const line of content.split("\n")) {
    const withoutComment = line.replace(/(^|\s)#.*$/, "");
    if (!withoutComment.trim()) continue;
    const indent = withoutComment.length - withoutComment.trimStart().length;
    const text = withoutComment.trim();

    // Dedent pops closed frames. A `pending` frame (`key:` awaiting its
    // value) survives a SAME-indent line: compose writes the block list at
    // the key's own indent (`depends_on:` then `  - redis`). Deeper-indented
    // pendings only expire when a shallower line arrives.
    while (stack.length > 1) {
      const topFrame = stack[stack.length - 1];
      const effectiveIndent = topFrame.kind === "pending" ? topFrame.indent - 1 : topFrame.indent;
      if (indent > effectiveIndent) break;
      const popped = stack.pop()!;
      if (popped.kind === "pending") popped.parent[popped.key] = {};
    }

    let top = stack[stack.length - 1];
    // Materialize a `key:` whose value is this (deeper) line.
    if (top.kind === "pending") {
      if (text.startsWith("- ")) {
        const arr: unknown[] = [];
        top.parent[top.key] = arr;
        stack[stack.length - 1] = { kind: "list", indent: top.indent, value: arr };
      } else {
        const obj: Record<string, unknown> = {};
        top.parent[top.key] = obj;
        stack[stack.length - 1] = { kind: "map", indent: top.indent, value: obj };
      }
      top = stack[stack.length - 1]!;
    }

    if (text.startsWith("- ")) {
      if (top.kind !== "list") continue;
      const item = text.slice(2).trim();
      // `KEY=value` env entries and quoted strings are plain scalars — never
      // yaml maps, even when the value contains `host:port`.
      const isScalarItem =
        /^[A-Za-z_][A-Za-z0-9_]*=/.test(item) || item.startsWith('"') || item.startsWith("'");
      // A `key: value` list entry needs the colon followed by whitespace or
      // end-of-line — otherwise `127.0.0.1:3002:3002` port strings would
      // parse as maps.
      const kv = isScalarItem ? null : /^([^:]+):(?:\s+(.*))?$/.exec(item);
      if (kv) {
        const obj: Record<string, unknown> = { [kv[1].trim()]: parseScalar(kv[2] ?? "") };
        top.value.push(obj);
        stack.push({ kind: "map", indent, value: obj });
      } else {
        top.value.push(parseScalar(item));
      }
      continue;
    }

    if (top.kind !== "map") continue;
    const kv = /^([^:]+):(?:\s(.*))?$/.exec(text);
    if (!kv) continue;
    const key = kv[1].trim().replace(/^['"]|['"]$/g, "");
    const rawVal = (kv[2] ?? "").trim();
    if (rawVal === "" || rawVal === "|" || rawVal === ">" || rawVal === "|-" || rawVal === ">-") {
      stack.push({ kind: "pending", indent, parent: top.value, key });
    } else {
      top.value[key] = parseScalar(rawVal);
    }
  }

  const servicesNode = root["services"];
  const out: Record<string, Record<string, unknown>> = {};
  if (servicesNode && typeof servicesNode === "object" && !Array.isArray(servicesNode)) {
    for (const [name, def] of Object.entries(servicesNode as Record<string, unknown>)) {
      if (def && typeof def === "object" && !Array.isArray(def)) {
        out[name] = def as Record<string, unknown>;
      }
    }
  }
  return out;
}

function firstKey(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  return keys.length ? keys[0] : null;
}

/** depends_on entries: list form (`- redis`) or map form (`redis: {condition: …}`). */
function dependsOnNames(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === "string" ? entry : firstKey(entry)))
      .filter((name): name is string => typeof name === "string");
  }
  if (value && typeof value === "object") return Object.keys(value);
  return [];
}

/** Env values from list form (`- KEY=value`) and map form (`KEY: value`). */
function envValues(value: unknown): string[] {
  const out: string[] = [];
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry !== "string") continue;
      const eq = entry.indexOf("=");
      if (eq > 0) out.push(entry.slice(eq + 1));
    }
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      if (typeof v === "string") out.push(v);
    }
  }
  return out;
}

/**
 * Configured edges from one compose file: `depends_on` + service-level
 * service refs + env values pointing at known host ports/hostnames.
 * Self-references and unmapped names are skipped — never emitted.
 */
export function parseComposeEdges(relPath: string, content: string): RawEdge[] {
  const edges: RawEdge[] = [];
  const services = parseComposeServices(content);
  // Generic service names ("api", "web") fall back to container_name, then
  // to the stack directory name so multi-service stacks still attribute.
  const stackSlug = slugForHostname(relPath.split("/")[0] ?? "");
  for (const [serviceName, def] of Object.entries(services)) {
    const containerName =
      typeof def["container_name"] === "string" ? (def["container_name"]) : null;
    const consumer =
      slugForHostname(serviceName) ??
      (containerName ? slugForHostname(containerName) : null) ??
      stackSlug;
    if (!consumer) continue;
    for (const dep of dependsOnNames(def["depends_on"])) {
      const provider = slugForHostname(dep);
      if (provider && provider !== consumer) {
        edges.push({
          source_slug: consumer,
          target_slug: provider,
          detail: `${relPath}: ${serviceName} depends_on ${dep}`,
        });
      }
    }
    for (const value of envValues(def["environment"])) {
      for (const provider of envValueToSlugs(value)) {
        if (provider !== consumer) {
          edges.push({
            source_slug: consumer,
            target_slug: provider,
            detail: `${relPath}: ${serviceName} env references ${provider}`,
          });
        }
      }
    }
  }
  return edges;
}

/** ss endpoint "127.0.0.1:5432" / "[fd00::1]:6333" / "*:5432" → { addr, port }. */
function parseAddrPort(addr: string): { addr: string; port: number } | null {
  const m = /^(.+):(\d+|\*)$/.exec(addr);
  if (!m || m[2] === "*") return null;
  const port = Number(m[2]);
  if (!Number.isFinite(port)) return null;
  const host = m[1].replace(/^\[|\]$/g, "");
  return { addr: host, port };
}

const LOOPBACK_ADDRS = new Set(["127.0.0.1", "::1", "0.0.0.0", "*", ""]);

/**
 * `ss -tnp` output → observed edges. LISTEN rows feed the port→provider
 * map; ESTABLISHED rows resolve the provider via the LISTEN map with a
 * PORT_TO_SLUG fallback (real `ss -tnp` often omits LISTEN sockets), and
 * the consumer via pid→slug attribution. Self-edges and unattributed
 * pids are skipped.
 */
export function parseSsEdges(
  ssOutput: string,
  attribution: {
    pidToSlug: ReadonlyMap<number, string>;
    ipToSlug?: ReadonlyMap<string, string>;
  },
): RawEdge[] {
  const { pidToSlug, ipToSlug } = attribution;
  const listenPortToSlug = new Map<number, string>();
  const established: {
    localAddr: string;
    localPort: number;
    peerAddr: string;
    peerPort: number;
    pids: number[];
  }[] = [];

  for (const rawLine of ssOutput.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("State")) continue;
    const fields = line.split(/\s+/);
    const state = fields[0];
    if (state !== "LISTEN" && state !== "ESTAB" && state !== "ESTABLISHED") continue;
    const local = parseAddrPort(fields[3] ?? "");
    const peer = parseAddrPort(fields[4] ?? "");
    if (state === "LISTEN") {
      if (local) {
        const slug = PORT_TO_SLUG[local.port];
        if (slug) listenPortToSlug.set(local.port, slug);
      }
      continue;
    }
    if (!local || !peer) continue;
    const pids: number[] = [];
    const processField = fields.slice(5).join(" ");
    const pidRe = /pid=(\d+)/g;
    let m = pidRe.exec(processField);
    while (m !== null) {
      pids.push(Number(m[1]));
      m = pidRe.exec(processField);
    }
    established.push({
      localAddr: local.addr,
      localPort: local.port,
      peerAddr: peer.addr,
      peerPort: peer.port,
      pids,
    });
  }

  const edges: RawEdge[] = [];
  const seen = new Set<string>();
  for (const conn of established) {
    // The service endpoint is whichever side is a known catalog port: peer
    // port for an outbound client connection, local port for the inbound
    // half of the same socket (ss lists both endpoints on one host).
    const peerProvider = listenPortToSlug.get(conn.peerPort) ?? PORT_TO_SLUG[conn.peerPort];
    const provider =
      peerProvider ?? listenPortToSlug.get(conn.localPort) ?? PORT_TO_SLUG[conn.localPort];
    if (!provider) continue;
    const servicePort = peerProvider ? conn.peerPort : conn.localPort;
    const consumers = new Set<string>();
    for (const pid of conn.pids) {
      const slug = pidToSlug.get(pid);
      if (slug) consumers.add(slug);
    }
    // Containers on a bridge network attribute by endpoint IP — required
    // under rootless docker, where ss pids live in a user namespace and
    // never intersect docker inspect's host pids.
    if (ipToSlug) {
      for (const addr of [conn.localAddr, conn.peerAddr]) {
        if (LOOPBACK_ADDRS.has(addr)) continue;
        const slug = ipToSlug.get(addr);
        if (slug) consumers.add(slug);
      }
    }
    for (const consumer of consumers) {
      if (consumer !== provider) {
        const key = `${consumer} ${provider}`;
        if (seen.has(key)) continue; // many sockets, one edge
        seen.add(key);
        edges.push({
          source_slug: consumer,
          target_slug: provider,
          detail: `ss: connection to port ${servicePort}`,
        });
      }
    }
  }
  return edges;
}

// ---------------------------------------------------------------------------
// Live probes.
// ---------------------------------------------------------------------------

interface ContainerAttribution {
  pidToSlug: Map<number, string>;
  ipToSlug: Map<string, string>;
}

async function resolveContainerAttribution(deps_: ScanDeps): Promise<ContainerAttribution> {
  const pidToSlug = new Map<number, string>();
  const ipToSlug = new Map<string, string>();
  let running: Set<string>;
  try {
    const { stdout } = await deps_.exec("/usr/bin/docker", ["ps", "--format", "{{.Names}}"], {
      timeout: 10_000,
    });
    running = new Set(
      stdout
        .split("\n")
        .map((n) => n.trim())
        .filter(Boolean),
    );
  } catch {
    return { pidToSlug, ipToSlug };
  }
  const known = Object.entries(CONTAINER_TO_SLUG).filter(([name]) => running.has(name));
  // Inspect each known container independently: one missing/dead container
  // must not discard the mappings of the others.
  await Promise.all(
    known.map(async ([name, slug]) => {
      try {
        const { stdout } = await deps_.exec(
          "/usr/bin/docker",
          [
            "inspect",
            "--format",
            "{{.State.Pid}} {{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}",
            name,
          ],
          { timeout: 5_000 },
        );
        const [pidField, ...ips] = stdout.trim().split(/\s+/).filter(Boolean);
        const pid = Number(pidField);
        if (Number.isFinite(pid) && pid > 0) pidToSlug.set(pid, slug);
        for (const ip of ips) ipToSlug.set(ip, slug);
      } catch {
        // skip this container only
      }
    }),
  );
  return { pidToSlug, ipToSlug };
}

async function collectConfiguredEdges(deps_: ScanDeps): Promise<RawEdge[]> {
  const stacksDir = dashboardPaths().stacks;
  let files: { path: string; content: string }[];
  try {
    files = await deps_.readComposeFiles();
  } catch {
    return []; // stacks dir unreadable — configured edges degrade to empty
  }
  const edges: RawEdge[] = [];
  for (const { path, content } of files) {
    try {
      const rel = path.startsWith(`${stacksDir}/`) ? path.slice(stacksDir.length + 1) : path;
      edges.push(...parseComposeEdges(rel, content));
    } catch {
      // one malformed compose file must not abort the scan
    }
  }
  return edges;
}

async function collectObservedEdges(deps_: ScanDeps): Promise<RawEdge[]> {
  try {
    const [{ stdout }, attribution] = await Promise.all([
      deps_.exec("/usr/bin/ss", ["-tnp"], { timeout: 10_000 }),
      resolveContainerAttribution(deps_),
    ]);
    return parseSsEdges(stdout, attribution);
  } catch {
    return []; // ss or docker unavailable → configured-only
  }
}

// ---------------------------------------------------------------------------
// Upsert — single multi-row INSERT, seed/manual rows protected in SQL.
// ---------------------------------------------------------------------------

async function upsertEdges(edges: ScannedEdge[]): Promise<number> {
  if (!edges.length) return 0;
  const values = sql.join(
    edges.map(
      (e) => sql`(${e.source_slug}, ${e.target_slug}, ${e.kind}, ${e.source}, ${e.detail})`,
    ),
    sql`, `,
  );
  const result = await db.execute(sql`
    INSERT INTO service_dependencies (source_slug, target_slug, kind, source, detail)
    VALUES ${values}
    ON CONFLICT (source_slug, target_slug, kind) DO UPDATE
      SET detail = EXCLUDED.detail,
          last_seen_at = now()
      WHERE service_dependencies.source NOT IN ('seed', 'manual')
  `);
  return typeof result.rowCount === "number" ? result.rowCount : 0;
}

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------

/**
 * Scan configured + observed dependency edges and upsert them. Never
 * throws: probe/exec/read errors degrade to whatever edge classes could
 * still be collected, and a failed upsert yields `upserted: 0` with the
 * collected edges still returned so the caller can log them.
 */
export async function scanDependencies(): Promise<ScanResult> {
  const [configured, observed] = await Promise.all([
    collectConfiguredEdges(deps),
    collectObservedEdges(deps),
  ]);

  // Dedupe by conflict key (source_slug, target_slug, kind) before the
  // single multi-row INSERT — Postgres refuses to touch one row twice.
  const merged = new Map<string, ScannedEdge>();
  for (const raw of configured) {
    merged.set(`${raw.source_slug} ${raw.target_slug} configured`, {
      ...raw,
      kind: "configured",
      source: "detected",
    });
  }
  for (const raw of observed) {
    merged.set(`${raw.source_slug} ${raw.target_slug} observed`, {
      ...raw,
      kind: "observed",
      source: "detected",
    });
  }
  const edges = [...merged.values()];
  let upserted = 0;
  try {
    upserted = await upsertEdges(edges);
  } catch {
    // broken DB must not turn a read-only scan into a 500
  }
  return { upserted, edges };
}
