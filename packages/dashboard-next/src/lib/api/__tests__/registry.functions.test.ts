// @vitest-environment node
/**
 * Phase-4 gate tests — registry (Docker Hub) server functions.
 *
 * Same harness as systemd.functions.test.ts: each gate is exercised via the
 * underlying `defineApiRoute` core so auth/rate-limit/validation are asserted
 * WITHOUT a real network call. The gate cores call the REAL exported handlers
 * from registry.functions.ts (searchDockerHubHandler / getDockerHubImageHandler)
 * against a stubbed `globalThis.fetch` — no duplicated fetch logic here.
 *
 * Upstream failures (non-200, timeout, malformed JSON) map to `badGatewayError`
 * (kind "bad_gateway" → HTTP 502 via httpStatusFor).
 *
 * Note: `auth: "any"` requires a valid session — anonymous requests are 401
 * (same as systemd listUnits); a non-admin authenticated user IS allowed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { z } from "zod";

import {
  InMemorySessionStore,
  setSessionStore,
  resetSessionStore,
  generateSessionToken,
} from "@/server/auth/session-store";
import { SESSION_COOKIE, setServerHmacKeyFromString } from "@/server/config";
import {
  defineApiRoute,
  resetRateLimitBuckets,
  type ApiRouteCore,
} from "@/server/server-fn-pipeline";
import { systemError, notFoundError } from "@/server/errors/types";
import {
  searchDockerHubHandler,
  getDockerHubImageHandler,
  type DockerHubImageDetail,
  type DockerHubSearchPayload,
} from "../registry.functions";

let store: InMemorySessionStore;

beforeEach(() => {
  setServerHmacKeyFromString("phase4-registry-test-deterministic-key-0123456789");
  resetSessionStore();
  store = new InMemorySessionStore();
  setSessionStore(store);
  resetRateLimitBuckets();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Input schemas — identical constraints to registry.functions.ts
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
// Gate cores (same options as registry.functions.ts; handlers ARE the real
// exported ones — error constructors injected statically here instead of via
// the handlers' dynamic @/server import).
// ---------------------------------------------------------------------------

const searchCore: ApiRouteCore = defineApiRoute({
  methods: ["GET"],
  auth: "any",
  input: SearchInput,
  rateLimit: { limit: 30, windowSec: 60, bucket: "user" },
  surface: "registry",
  action: "registry.search",
  target: (i) => (i as { query: string }).query,
  handler: ({ input }) =>
    searchDockerHubHandler(input, {
      systemError,
      notFoundError,
    }),
});

const imageCore: ApiRouteCore = defineApiRoute({
  methods: ["GET"],
  auth: "any",
  input: ImageInput,
  rateLimit: { limit: 30, windowSec: 60, bucket: "user" },
  surface: "registry",
  action: "registry.image",
  target: (i) => `${(i as { namespace: string }).namespace}/${(i as { name: string }).name}`,
  handler: ({ input }) =>
    getDockerHubImageHandler(input, {
      systemError,
      notFoundError,
    }),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeSession(): Promise<string> {
  const res = await store.createSession({
    username: "alice",
    csrfToken: generateSessionToken(),
    ip: "127.0.0.1",
    userAgent: "vitest",
    isAdmin: false,
  });
  return res.token;
}

function get(url: string, token?: string): Request {
  return new Request(url, {
    headers: token ? { cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` } : {},
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const HUB_FIXTURE = {
  count: 1,
  results: [
    {
      repo_name: "library/postgres",
      short_description: "The PostgreSQL object-relational database system.",
      star_count: 12000,
      pull_count: 1_500_000_000,
      is_official: true,
    },
  ],
};

// ---------------------------------------------------------------------------
// searchDockerHub
// ---------------------------------------------------------------------------

describe("registry.search gate (auth: any)", () => {
  it("401 without a session", async () => {
    const res = await searchCore(get("http://localhost/_serverFn/registry.search?query=postgres"));
    expect(res.status).toBe(401);
  });

  it("400 for an empty query", async () => {
    const token = await makeSession();
    const res = await searchCore(get("http://localhost/_serverFn/registry.search?query=", token));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("validation");
  });

  it("400 for an unexpected extra field (.strict)", async () => {
    const token = await makeSession();
    const res = await searchCore(
      get("http://localhost/_serverFn/registry.search?query=postgres&bogus=true", token),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("validation");
  });

  it("200 + mapped results on a mocked Docker Hub success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(HUB_FIXTURE));
    vi.stubGlobal("fetch", fetchMock);
    const token = await makeSession();
    const res = await searchCore(
      get("http://localhost/_serverFn/registry.search?query=postgres", token),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as DockerHubSearchPayload;
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({
      namespace: "library",
      name: "postgres",
      starCount: 12000,
      isOfficial: true,
    });
    expect(body.total).toBe(1);
    expect(fetchMock).toHaveBeenCalledOnce();
    const calledUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(calledUrl).toContain("query=postgres");
    expect(calledUrl).toContain("page_size=25");
  });

  it("appends the category keyword to the upstream query", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(HUB_FIXTURE));
    vi.stubGlobal("fetch", fetchMock);
    const token = await makeSession();
    const res = await searchCore(
      get("http://localhost/_serverFn/registry.search?query=postgres&category=database", token),
    );
    expect(res.status).toBe(200);
    const calledUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(calledUrl).toContain(encodeURIComponent("postgres database"));
  });

  it("maps upstream non-200 to a 502 bad_gateway error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, 503)));
    const token = await makeSession();
    const res = await searchCore(
      get("http://localhost/_serverFn/registry.search?query=postgres", token),
    );
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe("bad_gateway");
  });
});

// ---------------------------------------------------------------------------
// getDockerHubImage
// ---------------------------------------------------------------------------

describe("registry.image gate (auth: any)", () => {
  it("401 without a session", async () => {
    const res = await imageCore(
      get("http://localhost/_serverFn/registry.image?namespace=library&name=postgres"),
    );
    expect(res.status).toBe(401);
  });

  it("400 for a missing name", async () => {
    const token = await makeSession();
    const res = await imageCore(
      get("http://localhost/_serverFn/registry.image?namespace=library", token),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("validation");
  });

  it("200 + combined detail (README + tags) on mocked success", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (String(url).endsWith("tags/?page_size=10")) {
        return Promise.resolve(
          jsonResponse({
            results: [
              {
                name: "17",
                images: [
                  { architecture: "amd64", size: 120_000_000 },
                  { architecture: "arm64", size: 115_000_000 },
                ],
              },
            ],
          }),
        );
      }
      return Promise.resolve(
        jsonResponse({
          name: "postgres",
          namespace: "library",
          description: "PostgreSQL",
          full_description: "# Postgres\nThe README.",
          star_count: 12000,
          pull_count: 1_500_000_000,
          is_official: true,
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const token = await makeSession();
    const res = await imageCore(
      get("http://localhost/_serverFn/registry.image?namespace=library&name=postgres", token),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as DockerHubImageDetail;
    expect(body.fullDescription).toContain("# Postgres");
    expect(body.tags).toHaveLength(1);
    expect(body.tags[0]?.images).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("maps upstream failure on either fetch to a 502 bad_gateway error", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation((url: string) =>
        String(url).endsWith("tags/?page_size=10")
          ? Promise.resolve(jsonResponse({}, 500))
          : Promise.resolve(jsonResponse({ name: "postgres" })),
      );
    vi.stubGlobal("fetch", fetchMock);
    const token = await makeSession();
    const res = await imageCore(
      get("http://localhost/_serverFn/registry.image?namespace=library&name=postgres", token),
    );
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe("bad_gateway");
  });
});
