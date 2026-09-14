/**
 * Docker Hub registry — server functions (Phase 4).
 *
 * Transport is createServerFn RPC (ADR-001), same gate pattern as
 * systemd.functions.ts: `createServerFn(...).middleware([gate]).handler(
 * serverFnNoop)` with the gate carrying auth/rate-limit/audit.
 *
 * These handlers only fetch the PUBLIC Docker Hub v2 API — no privileged
 * host access. `@/server/errors/types` is imported dynamically inside each
 * handler so import-protection keeps `@/server/**` out of the client bundle
 * (same reason systemd.functions.ts does it; static import is impossible
 * across the client/server boundary here).
 *
 * Upstream failures (non-200, timeout, malformed JSON) map to `systemError`
 * (kind "system" → HTTP 500; the error model has no 502 kind) with a message
 * that names Docker Hub, so the UI can show a retry state.
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { defineServerFn, serverFnNoop } from "@/lib/api/define-server-fn";

// ---------------------------------------------------------------------------
// Result types (re-exported through the client facade)
// ---------------------------------------------------------------------------

export interface DockerHubSearchResult {
  name: string;
  namespace: string;
  description: string;
  starCount: number;
  pullCount: number;
  isOfficial: boolean;
}

export interface DockerHubSearchPayload {
  results: DockerHubSearchResult[];
  page: number;
  total: number | null;
}

export interface DockerHubTag {
  name: string;
  images: { architecture: string; size: number }[];
}

export interface DockerHubImageDetail {
  name: string;
  namespace: string;
  description: string;
  /** README markdown (Docker Hub `full_description`). */
  fullDescription: string;
  starCount: number;
  pullCount: number;
  isOfficial: boolean;
  tags: DockerHubTag[];
}

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const SearchInput = z
  .object({
    query: z.string().min(1).max(128),
    category: z.string().max(64).optional(),
    page: z.number().int().min(1).max(50).optional(),
  })
  .strict();

const ImageInput = z
  .object({
    namespace: z.string().min(1).max(64),
    name: z.string().min(1).max(128),
  })
  .strict();

// ---------------------------------------------------------------------------
// Upstream response schemas — Docker Hub is external input; validate once.
// Loose (.passthrough) so Hub-side additions never break parsing.
// ---------------------------------------------------------------------------

const HubRepoSummary = z
  .object({
    repo_name: z.string(),
    short_description: z.string().nullish(),
    star_count: z.number().nullish(),
    pull_count: z.number().nullish(),
    is_official: z.boolean().nullish(),
  })
  .passthrough();

const HubSearchResponse = z
  .object({
    count: z.number().nullish(),
    results: z.array(HubRepoSummary).nullish(),
  })
  .passthrough();

const HubRepoDetail = z
  .object({
    name: z.string().nullish(),
    namespace: z.string().nullish(),
    description: z.string().nullish(),
    full_description: z.string().nullish(),
    star_count: z.number().nullish(),
    pull_count: z.number().nullish(),
    is_official: z.boolean().nullish(),
  })
  .passthrough();

const HubTagsResponse = z
  .object({
    results: z
      .array(
        z
          .object({
            name: z.string(),
            images: z
              .array(
                z
                  .object({
                    architecture: z.string().nullish(),
                    size: z.number().nullish(),
                  })
                  .passthrough(),
              )
              .nullish(),
          })
          .passthrough(),
      )
      .nullish(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Fetch helper — 5s timeout, non-200 → typed system error
// ---------------------------------------------------------------------------

const HUB_BASE = "https://hub.docker.com/v2";
const FETCH_TIMEOUT_MS = 5_000;

async function fetchHubJson(url: string): Promise<unknown> {
  // Dynamic import keeps @/server/** out of the client bundle (ADR-001
  // import-protection); the specifier is a fixed literal, exception noted.
  const { badGatewayError } = await import("@/server/errors/types");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: "application/json" },
    });
  } catch (e) {
    const timedOut = e instanceof Error && e.name === "AbortError";
    throw badGatewayError(
      timedOut
        ? `Docker Hub did not respond within ${FETCH_TIMEOUT_MS / 1000}s`
        : "Docker Hub request failed",
      e,
    );
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw badGatewayError(`Docker Hub returned HTTP ${res.status} for ${url}`);
  }
  try {
    return await res.json();
  } catch (e) {
    throw badGatewayError("Docker Hub returned malformed JSON", e);
  }
}

/** `repo_name` is "namespace/name" for user repos, bare name for official ones. */
function splitRepoName(repoName: string): { namespace: string; name: string } {
  const slash = repoName.indexOf("/");
  return slash === -1
    ? { namespace: "library", name: repoName }
    : { namespace: repoName.slice(0, slash), name: repoName.slice(slash + 1) };
}

// ---------------------------------------------------------------------------
// Handlers — exported (test seam) so the contract test exercises the REAL
// fetch+map logic against a stubbed globalThis.fetch, not a copy of it.
// Error constructors are injected to keep @/server/** dynamic-import-only.
// ---------------------------------------------------------------------------

interface RegistryErrorCtors {
  systemError: (message: string, cause?: unknown) => Error;
  notFoundError: (message: string, resource?: string) => Error;
}

export async function searchDockerHubHandler(
  input: { query: string; category?: string; page?: number },
  errors: RegistryErrorCtors,
): Promise<DockerHubSearchPayload> {
  const page = input.page ?? 1;
  // Docker Hub has no category taxonomy — the category is a curated keyword
  // appended to the free-text query (see DockerSearch.tsx presets).
  const q = input.category ? `${input.query} ${input.category}` : input.query;
  const url = `${HUB_BASE}/search/repositories/?query=${encodeURIComponent(q)}&page=${page}&page_size=25`;
  const parsed = HubSearchResponse.safeParse(await fetchHubJson(url));
  if (!parsed.success) {
    throw errors.systemError("Docker Hub search response had an unexpected shape", parsed.error);
  }
  const results: DockerHubSearchResult[] = (parsed.data.results ?? []).map((r) => {
    const { namespace, name } = splitRepoName(r.repo_name);
    return {
      name,
      namespace,
      description: r.short_description ?? "",
      starCount: r.star_count ?? 0,
      pullCount: r.pull_count ?? 0,
      isOfficial: r.is_official ?? namespace === "library",
    };
  });
  return {
    results,
    page,
    total: parsed.data.count ?? null,
  } satisfies DockerHubSearchPayload;
}

export async function getDockerHubImageHandler(
  input: { namespace: string; name: string },
  errors: RegistryErrorCtors,
): Promise<DockerHubImageDetail> {
  const repoUrl = `${HUB_BASE}/repositories/${encodeURIComponent(input.namespace)}/${encodeURIComponent(input.name)}/`;
  const tagsUrl = `${repoUrl}tags/?page_size=10`;
  const [repoRaw, tagsRaw] = await Promise.all([fetchHubJson(repoUrl), fetchHubJson(tagsUrl)]);
  const repo = HubRepoDetail.safeParse(repoRaw);
  if (!repo.success) {
    throw errors.systemError("Docker Hub repository response had an unexpected shape", repo.error);
  }
  // A private/deleted repo 404s upstream; fetchHubJson already threw system
  // for non-200, so a missing name here means Hub returned an empty object.
  if (!repo.data.name) {
    throw errors.notFoundError(
      `Image '${input.namespace}/${input.name}' not found on Docker Hub`,
      "docker_hub_image",
    );
  }
  const tagsParsed = HubTagsResponse.safeParse(tagsRaw);
  const tags: DockerHubTag[] = tagsParsed.success
    ? (tagsParsed.data.results ?? []).map((t) => ({
        name: t.name,
        images: (t.images ?? []).map((img) => ({
          architecture: img.architecture ?? "unknown",
          size: img.size ?? 0,
        })),
      }))
    : [];
  return {
    name: repo.data.name,
    namespace: repo.data.namespace ?? input.namespace,
    description: repo.data.description ?? "",
    fullDescription: repo.data.full_description ?? "",
    starCount: repo.data.star_count ?? 0,
    pullCount: repo.data.pull_count ?? 0,
    isOfficial: repo.data.is_official ?? input.namespace === "library",
    tags,
  } satisfies DockerHubImageDetail;
}

/** Load the server error constructors (dynamic — client-bundle isolation). */
async function hubErrors(): Promise<RegistryErrorCtors> {
  const { systemError, notFoundError } = await import("@/server/errors/types");
  return { systemError, notFoundError };
}

// ---------------------------------------------------------------------------
// searchDockerHub — GET, auth: any, rate-limit 30/min/user
// ---------------------------------------------------------------------------

const searchDockerHubGate = defineServerFn({
  method: "GET",
  auth: "any",
  input: SearchInput,
  rateLimit: { limit: 30, windowSec: 60, bucket: "user" },
  surface: "registry",
  action: "registry.search",
  target: (input) => input.query,
  handler: async ({ input }) => searchDockerHubHandler(input, await hubErrors()),
});
export const searchDockerHub = createServerFn({ method: "GET" })
  .middleware([searchDockerHubGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
// getDockerHubImage — GET, auth: any, rate-limit 30/min/user
// ---------------------------------------------------------------------------

const getDockerHubImageGate = defineServerFn({
  method: "GET",
  auth: "any",
  input: ImageInput,
  rateLimit: { limit: 30, windowSec: 60, bucket: "user" },
  surface: "registry",
  action: "registry.image",
  target: (input) => `${input.namespace}/${input.name}`,
  handler: async ({ input }) => getDockerHubImageHandler(input, await hubErrors()),
});
export const getDockerHubImage = createServerFn({ method: "GET" })
  .middleware([getDockerHubImageGate])
  .handler(serverFnNoop);
