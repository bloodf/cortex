/**
 * Real Docker data — reads live containers from `docker ps` (WP-11).
 *
 * Ported from:
 *   packages/dashboard/src/lib/server/docker/real-data.ts
 *
 * Uses `docker ps --format json` (Docker 25.0+, line-delimited JSON),
 * `docker image ls --format json`, and `docker volume ls --format json`.
 * Stub data is available only in NODE_ENV=test with CORTEX_DOCKER_REAL=0.
 *
 * Cache: 3-second in-process cache per resource type. Actions call
 * invalidateCache() after execution so the next list reflects new state.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  Container,
  ContainerId,
  ContainerFilter,
  DockerImage,
  DockerVolume,
} from "./stub-data";
import {
  asContainerId,
  listContainers as stubListContainers,
  getContainerById as stubGetContainerById,
  getContainerByName as stubGetContainerByName,
  tailLogs as stubTailLogs,
  startContainer as stubStartContainer,
  stopContainer as stubStopContainer,
  restartContainer as stubRestartContainer,
  removeContainer as stubRemoveContainer,
  listImages as stubListImages,
  listVolumes as stubListVolumes,
} from "./stub-data";

const execFileAsync = promisify(execFile);

function isRealEnabled(): boolean {
  if (process.env.NODE_ENV !== "test") {
    if (process.env.CORTEX_DOCKER_REAL === "0") {
      throw new Error("CORTEX_DOCKER_REAL=0 is test-only; remove it to use the real Docker runtime");
    }
    if (process.platform !== "linux") throw new Error("Docker runtime requires Linux");
  }
  return process.env.CORTEX_DOCKER_REAL !== "0";
}

// Docker 25.0+ JSON format (line-delimited, one object per line)
interface DockerPsJson {
  ID?: string;
  Id?: string;
  Names?: string;
  Image?: string;
  State?: string;
  Status?: string;
  Ports?: string;
  CreatedAt?: string;
  Networks?: string;
  Mounts?: string;
}

function parseDockerDate(raw: string): string {
  try {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? raw : d.toISOString();
  } catch {
    return raw;
  }
}

function mapState(state: string): Container["state"] {
  const s = state.toLowerCase();
  if (s === "running") return "running";
  if (s === "exited" || s === "dead") return "exited";
  if (s === "paused") return "paused";
  if (s === "restarting") return "restarting";
  if (s === "created") return "created";
  return "exited";
}

async function loadContainersJson(): Promise<Container[]> {
  const { stdout } = await execFileAsync("docker", ["ps", "-a", "--format", "json"], {
    timeout: 10000,
    maxBuffer: 4 * 1024 * 1024,
  });

  const out = stdout
    .trim()
    .split("\n")
    .reduce<Container[]>((acc, line) => {
      if (!line.trim()) return acc;
      let raw: DockerPsJson;
      try {
        raw = JSON.parse(line);
      } catch {
        return acc;
      }
      const id = raw.ID || raw.Id || "";
      const names = (raw.Names || "").split(",").filter(Boolean);
      const name = names[0] || id.slice(0, 12) || "unknown";
      const networks = (raw.Networks || "").split(",").filter(Boolean);
      const mounts: Container["mounts"] = (raw.Mounts || "")
        .split(",")
        .map((m) => {
          const parts = m.split(":");
          if (parts.length < 2) return null;
          return {
            source: parts[0],
            destination: parts[1],
            mode: parts[2] || "rw",
          };
        })
        .filter(Boolean) as Container["mounts"];

      acc.push({
        id: asContainerId(id),
        name,
        image: raw.Image || "",
        state: mapState(raw.State || ""),
        status: raw.Status || raw.State || "",
        ports: (raw.Ports || "")
          .split(", ")
          .map((p) => p.trim())
          .filter(Boolean),
        created: parseDockerDate(raw.CreatedAt || ""),
        privileged: false,
        networks,
        mounts,
        logs: [],
      });
      return acc;
    }, []);
  return out;
}

let cache: Container[] | null = null;
let cacheAt = 0;
const CACHE_MS = 3000;

async function getContainers(): Promise<Container[]> {
  if (cache && Date.now() - cacheAt < CACHE_MS) return cache;
  try {
    cache = await loadContainersJson();
    cacheAt = Date.now();
    return cache;
  } catch (err) {
    throw new Error("Docker container inventory unavailable", { cause: err });
  }
}

export async function listContainers(
  opts: { filter?: ContainerFilter; query?: string } = {},
): Promise<Container[]> {
  if (!isRealEnabled()) return stubListContainers(opts);
  let rows = await getContainers();
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

export async function getContainerById(id: string): Promise<Container | null> {
  if (!id) return null;
  if (!isRealEnabled()) return stubGetContainerById(id);
  const rows = await getContainers();
  return rows.find((c) => c.id === id || c.id.endsWith(id)) ?? null;
}

export async function getContainerByName(name: string): Promise<Container | null> {
  if (!name) return null;
  if (!isRealEnabled()) return stubGetContainerByName(name);
  const rows = await getContainers();
  return rows.find((c) => c.name === name) ?? null;
}

export async function tailLogs(id: string, n: number): Promise<string[]> {
  if (!isRealEnabled()) return stubTailLogs(id, n);
  const c = await getContainerById(id);
  if (!c) return [];
  const max = Math.max(1, Math.min(1000, n));
  try {
    // `docker logs` writes the container's stderr stream to the CLI's stderr
    // (and stdout to CLI's stdout). Merging both streams (MP-009) — previously
    // only stdout was captured, so any container that emits errors via
    // stderr showed up blank.
    const { stdout, stderr } = await execFileAsync(
      "docker",
      ["logs", "--tail", String(max), c.id],
      { timeout: 10000, maxBuffer: 2 * 1024 * 1024 },
    );
    return [...stdout.split("\n"), ...stderr.split("\n")]
      .map((l) => l.replace(/\r$/, ""))
      .filter(Boolean);
  } catch (err) {
    throw new Error(`Docker logs unavailable for ${c.name}`, { cause: err });
  }
}

let imageCache: DockerImage[] | null = null;
let imageCacheAt = 0;
let volumeCache: DockerVolume[] | null = null;
let volumeCacheAt = 0;

export function invalidateCache(): void {
  cache = null;
  cacheAt = 0;
  imageCache = null;
  imageCacheAt = 0;
  volumeCache = null;
  volumeCacheAt = 0;
}

// ---------------------------------------------------------------------------
// Actions — wrappers around docker CLI, each calls invalidateCache()
// ---------------------------------------------------------------------------

export async function startContainer(id: string): Promise<{ id: string; state: string }> {
  if (!isRealEnabled()) {
    const c = stubStartContainer(id);
    return { id: c.id, state: c.state };
  }
  await execFileAsync("docker", ["start", id], { timeout: 30000 });
  invalidateCache();
  return { id, state: "running" };
}

export async function stopContainer(id: string): Promise<{ id: string; state: string }> {
  if (!isRealEnabled()) {
    const c = stubStopContainer(id);
    return { id: c.id, state: c.state };
  }
  await execFileAsync("docker", ["stop", id], { timeout: 30000 });
  invalidateCache();
  return { id, state: "exited" };
}

export async function restartContainer(id: string): Promise<{ id: string; state: string }> {
  if (!isRealEnabled()) {
    const c = stubRestartContainer(id);
    return { id: c.id, state: c.state };
  }
  await execFileAsync("docker", ["restart", id], { timeout: 30000 });
  invalidateCache();
  return { id, state: "running" };
}

export async function removeContainer(id: string): Promise<boolean> {
  if (!isRealEnabled()) return stubRemoveContainer(id);
  await execFileAsync("docker", ["rm", id], { timeout: 30000 });
  invalidateCache();
  return true;
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

interface DockerImageJson {
  ID?: string;
  Repository?: string;
  Tag?: string;
  Size?: string;
  CreatedAt?: string;
}

function parseImageSize(raw: string): number {
  const s = raw.trim().toLowerCase();
  const match = s.match(/^([\d.]+)\s*(b|kb|mb|gb|tb)$/);
  if (!match) return 0;
  const n = parseFloat(match[1] ?? "0");
  const unit = match[2] ?? "b";
  const multipliers: Record<string, number> = {
    b: 1,
    kb: 1024,
    mb: 1024 * 1024,
    gb: 1024 * 1024 * 1024,
    tb: 1024 * 1024 * 1024 * 1024,
  };
  return Math.round(n * (multipliers[unit] ?? 1));
}

async function loadImagesJson(): Promise<DockerImage[]> {
  const { stdout } = await execFileAsync("docker", ["image", "ls", "--format", "json"], {
    timeout: 10000,
    maxBuffer: 4 * 1024 * 1024,
  });

  // Deduplicate by repo:tag — docker image ls can emit the same repo:tag
  // pair more than once when an image has multiple tags pointing to the
  // same digest. We keep the first occurrence (newest CreatedAt order
  // is already the default from docker image ls).
  const out: DockerImage[] = [];
  const seen = new Set<string>();
  stdout
    .trim()
    .split("\n")
    .forEach((line) => {
      if (!line.trim()) return;
      let raw: DockerImageJson;
      try {
        raw = JSON.parse(line);
      } catch {
        return;
      }
      const repo = raw.Repository || "";
      const tag = raw.Tag || "";
      // Drop dangling images — these have no meaningful reference.
      if (!repo || repo === "<none>" || !tag || tag === "<none>") return;
      const key = `${repo}:${tag}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({
        id: raw.ID || "",
        repo,
        tag,
        size: parseImageSize(raw.Size || "0B"),
        created: parseDockerDate(raw.CreatedAt || ""),
      });
    });
  return out;
}

async function getImages(): Promise<DockerImage[]> {
  if (imageCache && Date.now() - imageCacheAt < CACHE_MS) return imageCache;
  try {
    imageCache = await loadImagesJson();
    imageCacheAt = Date.now();
    return imageCache;
  } catch (err) {
    throw new Error("Docker image inventory unavailable", { cause: err });
  }
}

export async function listImages(opts: { query?: string } = {}): Promise<DockerImage[]> {
  if (!isRealEnabled()) return stubListImages(opts);
  let rows = await getImages();
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

interface DockerVolumeJson {
  Name?: string;
  Driver?: string;
  Mountpoint?: string;
  Size?: string;
  CreatedAt?: string;
  Labels?: string;
}

function parseVolumeLabels(raw: string): Record<string, string> {
  return (raw || "").split(",").reduce<Record<string, string>>((acc, part) => {
    const [k, v] = part.split("=");
    if (k) acc[k.trim()] = (v || "").trim();
    return acc;
  }, {});
}

async function loadVolumesJson(): Promise<DockerVolume[]> {
  const { stdout } = await execFileAsync("docker", ["volume", "ls", "--format", "json"], {
    timeout: 10000,
    maxBuffer: 4 * 1024 * 1024,
  });

  const out: DockerVolume[] = [];
  stdout
    .trim()
    .split("\n")
    .forEach((line) => {
      if (!line.trim()) return;
      let raw: DockerVolumeJson;
      try {
        raw = JSON.parse(line);
      } catch {
        return;
      }
      const sizeRaw = raw.Size || "";
      const sizeNum = sizeRaw ? parseImageSize(sizeRaw) : null;
      out.push({
        name: raw.Name || "",
        driver: raw.Driver || "local",
        mountpoint: raw.Mountpoint || "",
        size: sizeNum,
        createdAt: raw.CreatedAt ? parseDockerDate(raw.CreatedAt) : null,
        labels: parseVolumeLabels(raw.Labels || ""),
      });
    });
  return out;
}

async function getVolumes(): Promise<DockerVolume[]> {
  if (volumeCache && Date.now() - volumeCacheAt < CACHE_MS) return volumeCache;
  try {
    volumeCache = await loadVolumesJson();
    volumeCacheAt = Date.now();
    return volumeCache;
  } catch (err) {
    throw new Error("Docker volume inventory unavailable", { cause: err });
  }
}

export async function listVolumes(opts: { query?: string } = {}): Promise<DockerVolume[]> {
  if (!isRealEnabled()) return stubListVolumes(opts);
  let rows = await getVolumes();
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

// Re-export types for consumers
export type { Container, ContainerId, ContainerFilter, DockerImage, DockerVolume };
