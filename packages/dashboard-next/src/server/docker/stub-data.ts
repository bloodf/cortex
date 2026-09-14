/**
 * Docker stub data — in-memory fallback types and seed data (WP-11).
 *
 * Ported verbatim from:
 *   packages/dashboard/src/lib/server/docker/stub-data.ts
 *
 * The real-data module imports types from this file. The seed values
 * are used when CORTEX_DOCKER_REAL=0 (or Docker is unavailable in dev/test).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Branded id primitive — match the contracts `DockerContainer.id`
 * shape (sha256:hex or a 12-64 char hex string).
 */
export type ContainerId = string & { readonly __brand: "ContainerId" };

export const asContainerId = (s: string): ContainerId => s as ContainerId;

export type ContainerState = "running" | "exited" | "paused" | "restarting" | "created" | "dead";

/** Mounts (host:container[:ro]) — same shape the contracts use. */
export interface ContainerMount {
  source: string;
  destination: string;
  mode: string;
}

export interface Container {
  readonly id: ContainerId;
  readonly name: string;
  readonly image: string;
  readonly state: ContainerState;
  /** Free-form status text (e.g. "Up 3 days"). */
  readonly status: string;
  readonly ports: readonly string[];
  readonly created: string;
  readonly privileged: boolean;
  readonly networks: readonly string[];
  readonly mounts: readonly ContainerMount[];
  /**
   * Last N log lines kept in memory. The stub does not actually
   * read docker logs — it returns synthetic lines. Real data uses
   * `docker logs --tail <N> <id>`.
   */
  readonly logs: readonly string[];
}

export type ContainerFilter = "all" | "running" | "stopped" | "paused" | "restarting";

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

const FROZEN_NOW = "2026-06-09T12:00:00.000Z";

function frozenMinusMinutes(minutes: number): string {
  const t = Date.parse(FROZEN_NOW) - minutes * 60_000;
  return new Date(t).toISOString();
}

// ---------------------------------------------------------------------------
// Container seed
// ---------------------------------------------------------------------------

const SEED: readonly Omit<Container, "logs">[] = [
  {
    id: asContainerId("sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    name: "grafana-1",
    image: "grafana/grafana:11.2.0",
    state: "running",
    status: "Up 2 hours",
    ports: ["3000:3000"],
    created: frozenMinusMinutes(120),
    privileged: false,
    networks: ["monitoring", "bridge"],
    mounts: [{ source: "grafana-data", destination: "/var/lib/grafana", mode: "rw" }],
  },
  {
    id: asContainerId("sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
    name: "prometheus-1",
    image: "prom/prometheus:v2.55.0",
    state: "running",
    status: "Up 2 hours",
    ports: ["9090:9090"],
    created: frozenMinusMinutes(120),
    privileged: false,
    networks: ["monitoring"],
    mounts: [{ source: "prometheus-data", destination: "/prometheus", mode: "rw" }],
  },
  {
    id: asContainerId("sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"),
    name: "caddy-1",
    image: "caddy:2.8-alpine",
    state: "running",
    status: "Up 4 hours",
    ports: ["80:80", "443:443"],
    created: frozenMinusMinutes(240),
    privileged: false,
    networks: ["bridge"],
    mounts: [{ source: "/etc/caddy", destination: "/etc/caddy", mode: "ro" }],
  },
  {
    id: asContainerId("sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"),
    name: "postgres-1",
    image: "postgres:16-alpine",
    state: "exited",
    status: "Exited (0) 30 minutes ago",
    ports: ["5432:5432"],
    created: frozenMinusMinutes(600),
    privileged: false,
    networks: ["bridge"],
    mounts: [{ source: "postgres-data", destination: "/var/lib/postgresql/data", mode: "rw" }],
  },
];

/** Synthetic per-container log lines. */
const SYNTHETIC_LOGS: Readonly<Record<string, readonly string[]>> = {
  "grafana-1": [
    't=2026-06-09T10:00:00 lvl=info msg="Starting Grafana" version=11.2.0',
    't=2026-06-09T10:00:01 lvl=info msg="HTTP Server Listen" address=[::]:3000',
  ],
  "prometheus-1": [
    'level=info ts=2026-06-09T10:00:00 caller=main.go:567 msg="Starting Prometheus"',
    'level=info ts=2026-06-09T10:00:01 caller=web.go:571 msg="Start listening" address=0.0.0.0:9090',
  ],
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

let containers: Container[] = SEED.map((c) => ({
  ...c,
  logs: SYNTHETIC_LOGS[c.name] ?? [],
}));

// ---------------------------------------------------------------------------
// Public API — read
// ---------------------------------------------------------------------------

export function listContainers(
  opts: { filter?: ContainerFilter; query?: string } = {},
): Container[] {
  let rows = containers.slice();
  const filter = opts.filter ?? "all";
  if (filter === "running") {
    rows = rows.filter((c) => c.state === "running");
  } else if (filter === "stopped") {
    rows = rows.filter((c) => c.state === "exited" || c.state === "created" || c.state === "dead");
  } else if (filter === "paused") {
    rows = rows.filter((c) => c.state === "paused");
  } else if (filter === "restarting") {
    rows = rows.filter((c) => c.state === "restarting");
  }
  const needle = (opts.query ?? "").trim().toLowerCase();
  if (needle) {
    rows = rows.filter(
      (c) =>
        c.name.toLowerCase().includes(needle) ||
        c.image.toLowerCase().includes(needle) ||
        c.state.toLowerCase().includes(needle),
    );
  }
  return rows;
}

export function getContainerById(id: string): Container | null {
  if (!id) return null;
  return containers.find((c) => c.id === id || c.id.endsWith(id)) ?? null;
}

export function getContainerByName(name: string): Container | null {
  if (!name) return null;
  return containers.find((c) => c.name === name) ?? null;
}

export function tailLogs(id: string, n: number): string[] {
  const c = getContainerById(id);
  if (!c) return [];
  const max = Math.max(1, Math.min(1000, n));
  return c.logs.slice(-max);
}

// ---------------------------------------------------------------------------
// Public API — write (lifecycle actions)
// ---------------------------------------------------------------------------

function setState(c: Container, next: ContainerState, status: string): Container {
  const idx = containers.findIndex((x) => x.id === c.id);
  if (idx < 0) return c;
  const updated: Container = { ...c, state: next, status };
  containers[idx] = updated;
  return updated;
}

export function startContainer(id: string): Container {
  const c = getContainerById(id);
  if (!c) throw new Error(`Container '${id}' not found`);
  return setState(c, "running", "Up 0 seconds");
}

export function stopContainer(id: string): Container {
  const c = getContainerById(id);
  if (!c) throw new Error(`Container '${id}' not found`);
  return setState(c, "exited", "Exited (0) 0 seconds ago");
}

export function restartContainer(id: string): Container {
  const c = getContainerById(id);
  if (!c) throw new Error(`Container '${id}' not found`);
  return setState(c, "running", "Up 0 seconds (restarted)");
}

export function removeContainer(id: string): boolean {
  const idx = containers.findIndex((c) => c.id === id || c.id.endsWith(id));
  if (idx < 0) return false;
  containers.splice(idx, 1);
  return true;
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

export interface DockerImage {
  readonly id: string;
  readonly repo: string;
  readonly tag: string;
  readonly size: number;
  readonly created: string;
}

const IMAGE_SEED: readonly DockerImage[] = [
  {
    id: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1",
    repo: "grafana/grafana",
    tag: "11.2.0",
    size: 385_000_000,
    created: frozenMinusMinutes(10_080),
  },
  {
    id: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2",
    repo: "prom/prometheus",
    tag: "v2.55.0",
    size: 280_000_000,
    created: frozenMinusMinutes(10_080),
  },
  {
    id: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa3",
    repo: "caddy",
    tag: "2.8-alpine",
    size: 45_000_000,
    created: frozenMinusMinutes(20_160),
  },
  {
    id: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa4",
    repo: "postgres",
    tag: "16-alpine",
    size: 250_000_000,
    created: frozenMinusMinutes(20_160),
  },
];

let images: DockerImage[] = IMAGE_SEED.slice();

export function listImages(opts: { query?: string } = {}): DockerImage[] {
  let rows = images.slice();
  const needle = (opts.query ?? "").trim().toLowerCase();
  if (needle) {
    rows = rows.filter(
      (i) =>
        i.repo.toLowerCase().includes(needle) ||
        i.tag.toLowerCase().includes(needle) ||
        i.id.toLowerCase().includes(needle),
    );
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Volumes
// ---------------------------------------------------------------------------

export interface DockerVolume {
  readonly name: string;
  readonly driver: string;
  readonly mountpoint: string;
  readonly size: number | null;
  readonly createdAt: string | null;
  readonly labels: Readonly<Record<string, string>>;
}

const VOLUME_SEED: readonly DockerVolume[] = [
  {
    name: "grafana-data",
    driver: "local",
    mountpoint: "/var/lib/docker/volumes/grafana-data/_data",
    size: 45_000_000,
    createdAt: frozenMinusMinutes(10_080),
    labels: {},
  },
  {
    name: "prometheus-data",
    driver: "local",
    mountpoint: "/var/lib/docker/volumes/prometheus-data/_data",
    size: 120_000_000,
    createdAt: frozenMinusMinutes(10_080),
    labels: {},
  },
  {
    name: "postgres-data",
    driver: "local",
    mountpoint: "/var/lib/docker/volumes/postgres-data/_data",
    size: 85_000_000,
    createdAt: frozenMinusMinutes(20_160),
    labels: {},
  },
];

let volumes: DockerVolume[] = VOLUME_SEED.slice();

export function listVolumes(opts: { query?: string } = {}): DockerVolume[] {
  let rows = volumes.slice();
  const needle = (opts.query ?? "").trim().toLowerCase();
  if (needle) {
    rows = rows.filter(
      (v) =>
        v.name.toLowerCase().includes(needle) ||
        v.driver.toLowerCase().includes(needle) ||
        v.mountpoint.toLowerCase().includes(needle),
    );
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

/** Reset the store to the seed. For tests only. */
export function resetDockerStub(): void {
  containers = SEED.map((c) => ({
    ...c,
    logs: SYNTHETIC_LOGS[c.name] ?? [],
  }));
  images = IMAGE_SEED.slice();
  volumes = VOLUME_SEED.slice();
}
