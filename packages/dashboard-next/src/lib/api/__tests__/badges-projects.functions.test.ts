// @vitest-environment node
/**
 * P2 gate tests — badges + projects create/update/delete mutating server fns.
 *
 * The audit's #1 lesson: drive the REAL exported gate options
 * (`badgesCreateGateOptions`, `projectsPatchGateOptions`, …) through the REAL
 * `defineApiRoute` pipeline against a REAL DB-shaped PGlite (`createTestDb`),
 * NOT a hand-rolled inline gate with UUID-string fixtures. Both id schemas are
 * `z.coerce.number().int().positive()` over an integer serial id — the exact
 * shape that let a prod regression slip past UUID-string tests — so the
 * coercion edge (non-numeric string → 400; real integer → pass) is asserted.
 *
 * Each suite covers: 401 unauthenticated · 403 non-admin · 403 CSRF-missing on
 * the mutation · 400 invalid input (incl. integer-id coercion) · happy-path
 * success that also asserts a durable audit row is written.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";

import {
  InMemorySessionStore,
  setSessionStore,
  resetSessionStore,
  generateSessionToken,
} from "@/server/auth/session-store";
import { SESSION_COOKIE, CSRF_COOKIE, setServerHmacKeyFromString } from "@/server/config";
import {
  defineApiRoute,
  resetRateLimitBuckets,
  flushDurableAudit,
  type ApiRouteCore,
} from "@/server/server-fn-pipeline";
import { setDbForTests, resetDbForTests } from "@/server/db/client";
import { createTestDb, type PgliteDbClient } from "@/server/db/test-utils";
import { auditLog, badges, projects } from "@/server/db/schema";
import type { ServerFnOptions } from "@/lib/api/define-server-fn";

import {
  badgesCreateGateOptions,
  badgesPatchGateOptions,
  badgesDeleteGateOptions,
} from "../badges.functions";
import {
  projectsCreateGateOptions,
  projectsPatchGateOptions,
  projectsDeleteGateOptions,
} from "../projects.functions";

// ---------------------------------------------------------------------------
// Harness (mirrors audit-durable.test.ts — real pipeline, real pglite DB)
// ---------------------------------------------------------------------------

let store: InMemorySessionStore;
let db: PgliteDbClient;
let client: Awaited<ReturnType<typeof createTestDb>>["client"];

beforeAll(() => {
  setServerHmacKeyFromString("badges-projects-deterministic-key-0123456789abcdef");
});

beforeEach(async () => {
  resetSessionStore();
  store = new InMemorySessionStore();
  setSessionStore(store);
  resetRateLimitBuckets();

  const made = await createTestDb({ seed: true });
  db = made.db;
  client = made.client;
  setDbForTests(db);
});

afterEach(async () => {
  await flushDurableAudit();
  await client.close();
  resetDbForTests();
});

function cookieHeader(parts: Record<string, string>): string {
  return Object.entries(parts)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("; ");
}

async function makeSession(opts: { isAdmin: boolean }): Promise<{ token: string; csrf: string }> {
  const csrf = generateSessionToken();
  const res = await store.createSession({
    username: opts.isAdmin ? "admin" : "alice",
    csrfToken: csrf,
    ip: "127.0.0.1",
    userAgent: "vitest",
    isAdmin: opts.isAdmin,
  });
  return { token: res.token, csrf };
}

/** Build an ApiRouteCore from exported gate options (single source of truth). */
function coreFor<TIn, TOut>(opts: ServerFnOptions<TIn, TOut>): ApiRouteCore {
  return defineApiRoute({ methods: [opts.method], ...opts });
}

function post(
  core: ApiRouteCore,
  path: string,
  opts: { token?: string; csrfCookie?: string; csrfHeader?: string; body?: unknown },
): Promise<Response> {
  const cookies: Record<string, string> = {};
  if (opts.token) cookies[SESSION_COOKIE] = opts.token;
  if (opts.csrfCookie) cookies[CSRF_COOKIE] = opts.csrfCookie;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (Object.keys(cookies).length) headers.cookie = cookieHeader(cookies);
  if (opts.csrfHeader) headers["x-csrf-token"] = opts.csrfHeader;
  return core(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(opts.body ?? {}),
    }),
  );
}

async function auditRows(source: string, eventType: string) {
  await flushDurableAudit();
  const rows = await db.select().from(auditLog);
  return rows.filter((r) => r.source === source && r.eventType === eventType);
}

// ===========================================================================
// BADGES
// ===========================================================================

describe("badges.create gate (auth: admin, POST mutation)", () => {
  const core = coreFor(badgesCreateGateOptions);
  const goodBody = { slug: "newbadge", label: "New", color: "#112233", textColor: "#ffffff" };

  it("401 when unauthenticated", async () => {
    const res = await post(core, "/_serverFn/badges.create", { body: goodBody });
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("auth");
  });

  it("403 for an authenticated non-admin (even with valid CSRF)", async () => {
    const { token, csrf } = await makeSession({ isAdmin: false });
    const res = await post(core, "/_serverFn/badges.create", {
      token,
      csrfCookie: csrf,
      csrfHeader: csrf,
      body: goodBody,
    });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("permission");
  });

  it("403 for an admin with NO CSRF header (stolen-cookie attack)", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const res = await post(core, "/_serverFn/badges.create", {
      token,
      csrfCookie: csrf,
      body: goodBody,
    });
    expect(res.status).toBe(403);
  });

  it("400 on invalid input (bad hex color)", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const res = await post(core, "/_serverFn/badges.create", {
      token,
      csrfCookie: csrf,
      csrfHeader: csrf,
      body: { slug: "x", label: "X", color: "not-a-hex", textColor: "#ffffff" },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("validation");
  });

  it("201 happy path → inserts a row AND writes a durable audit row", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const res = await post(core, "/_serverFn/badges.create", {
      token,
      csrfCookie: csrf,
      csrfHeader: csrf,
      body: goodBody,
    });
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created).toMatchObject({ slug: "newbadge", label: "New" });
    expect(typeof created.id).toBe("number"); // integer serial id, not a UUID

    const inDb = await db.select().from(badges);
    expect(inDb.some((b) => b.slug === "newbadge")).toBe(true);

    const audit = await auditRows("badges", "badges.create");
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect((audit[0].payload as Record<string, unknown>).result).toBe("success");
  });
});

describe("badges.update gate (auth: admin) — integer-id coercion", () => {
  const core = coreFor(badgesPatchGateOptions);

  async function seedBadge(): Promise<number> {
    const [row] = await db
      .insert(badges)
      .values({ slug: "seed", label: "Seed", color: "#101010", textColor: "#ffffff" })
      .returning();
    return row.id; // real integer serial id
  }

  it("400 when the integer serial id is a string-that's-not-a-number", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const res = await post(core, "/_serverFn/badges.update", {
      token,
      csrfCookie: csrf,
      csrfHeader: csrf,
      body: { id: "not-a-number", label: "Nope" },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("validation");
  });

  it("201 with a real integer id (coercion passes) → row updated + audit row", async () => {
    const id = await seedBadge();
    const { token, csrf } = await makeSession({ isAdmin: true });
    const res = await post(core, "/_serverFn/badges.update", {
      token,
      csrfCookie: csrf,
      csrfHeader: csrf,
      body: { id, label: "Renamed" },
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ id, label: "Renamed" });

    const audit = await auditRows("badges", "badges.update");
    expect(audit.length).toBeGreaterThanOrEqual(1);
  });

  it("404 for a well-formed integer id that does not exist", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const res = await post(core, "/_serverFn/badges.update", {
      token,
      csrfCookie: csrf,
      csrfHeader: csrf,
      body: { id: 999999, label: "Ghost" },
    });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("not_found");
  });
});

describe("badges.delete gate (auth: admin) — integer-id coercion", () => {
  const core = coreFor(badgesDeleteGateOptions);

  it("401 when unauthenticated", async () => {
    const res = await post(core, "/_serverFn/badges.delete", { body: { id: 1 } });
    expect(res.status).toBe(401);
  });

  it("403 for an admin with NO CSRF header", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const res = await post(core, "/_serverFn/badges.delete", {
      token,
      csrfCookie: csrf,
      body: { id: 1 },
    });
    expect(res.status).toBe(403);
  });

  it("400 when the integer id is a non-numeric string", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const res = await post(core, "/_serverFn/badges.delete", {
      token,
      csrfCookie: csrf,
      csrfHeader: csrf,
      body: { id: "abc" },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("validation");
  });

  it("201 happy path with a real integer id → row gone + audit row", async () => {
    const [row] = await db
      .insert(badges)
      .values({ slug: "doomed", label: "Doomed", color: "#202020", textColor: "#ffffff" })
      .returning();
    const { token, csrf } = await makeSession({ isAdmin: true });
    const res = await post(core, "/_serverFn/badges.delete", {
      token,
      csrfCookie: csrf,
      csrfHeader: csrf,
      body: { id: row.id },
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ ok: true });

    const remaining = await db.select().from(badges);
    expect(remaining.some((b) => b.id === row.id)).toBe(false);

    const audit = await auditRows("badges", "badges.delete");
    expect(audit.length).toBeGreaterThanOrEqual(1);
  });
});

// ===========================================================================
// PROJECTS
// ===========================================================================

describe("projects.create gate (auth: admin, POST mutation)", () => {
  const core = coreFor(projectsCreateGateOptions);
  const goodBody = { slug: "newproj", name: "New Project" };

  it("401 when unauthenticated", async () => {
    const res = await post(core, "/_serverFn/projects.create", { body: goodBody });
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("auth");
  });

  it("403 for an authenticated non-admin (even with valid CSRF)", async () => {
    const { token, csrf } = await makeSession({ isAdmin: false });
    const res = await post(core, "/_serverFn/projects.create", {
      token,
      csrfCookie: csrf,
      csrfHeader: csrf,
      body: goodBody,
    });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("permission");
  });

  it("403 for an admin with NO CSRF header (stolen-cookie attack)", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const res = await post(core, "/_serverFn/projects.create", {
      token,
      csrfCookie: csrf,
      body: goodBody,
    });
    expect(res.status).toBe(403);
  });

  it("400 on invalid input (bad slug pattern)", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const res = await post(core, "/_serverFn/projects.create", {
      token,
      csrfCookie: csrf,
      csrfHeader: csrf,
      body: { slug: "Bad Slug!", name: "X" },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("validation");
  });

  it("201 happy path → inserts a row AND writes a durable audit row", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const res = await post(core, "/_serverFn/projects.create", {
      token,
      csrfCookie: csrf,
      csrfHeader: csrf,
      body: goodBody,
    });
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created).toMatchObject({ slug: "newproj", name: "New Project" });
    expect(typeof created.id).toBe("number");

    const inDb = await db.select().from(projects);
    expect(inDb.some((p) => p.slug === "newproj")).toBe(true);

    const audit = await auditRows("projects", "projects.create");
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect((audit[0].payload as Record<string, unknown>).result).toBe("success");
  });
});

describe("projects.update gate (auth: admin) — integer-id coercion", () => {
  const core = coreFor(projectsPatchGateOptions);

  async function seedProject(): Promise<number> {
    const [row] = await db
      .insert(projects)
      .values({ slug: "seedproj", name: "Seed Project" })
      .returning();
    return row.id;
  }

  it("400 when the integer serial id is a string-that's-not-a-number", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const res = await post(core, "/_serverFn/projects.update", {
      token,
      csrfCookie: csrf,
      csrfHeader: csrf,
      body: { id: "xyz", name: "Nope" },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("validation");
  });

  it("201 with a real integer id (coercion passes) → row updated + audit row", async () => {
    const id = await seedProject();
    const { token, csrf } = await makeSession({ isAdmin: true });
    const res = await post(core, "/_serverFn/projects.update", {
      token,
      csrfCookie: csrf,
      csrfHeader: csrf,
      body: { id, name: "Renamed Project" },
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ id, name: "Renamed Project" });

    const audit = await auditRows("projects", "projects.update");
    expect(audit.length).toBeGreaterThanOrEqual(1);
  });

  it("404 for a well-formed integer id that does not exist", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const res = await post(core, "/_serverFn/projects.update", {
      token,
      csrfCookie: csrf,
      csrfHeader: csrf,
      body: { id: 999999, name: "Ghost" },
    });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("not_found");
  });
});

describe("projects.delete gate (auth: admin) — integer-id coercion", () => {
  const core = coreFor(projectsDeleteGateOptions);

  it("401 when unauthenticated", async () => {
    const res = await post(core, "/_serverFn/projects.delete", { body: { id: 1 } });
    expect(res.status).toBe(401);
  });

  it("403 for an admin with NO CSRF header", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const res = await post(core, "/_serverFn/projects.delete", {
      token,
      csrfCookie: csrf,
      body: { id: 1 },
    });
    expect(res.status).toBe(403);
  });

  it("400 when the integer id is a non-numeric string", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const res = await post(core, "/_serverFn/projects.delete", {
      token,
      csrfCookie: csrf,
      csrfHeader: csrf,
      body: { id: "nope" },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("validation");
  });

  it("201 happy path with a real integer id → row gone + audit row", async () => {
    const [row] = await db
      .insert(projects)
      .values({ slug: "doomedproj", name: "Doomed Project" })
      .returning();
    const { token, csrf } = await makeSession({ isAdmin: true });
    const res = await post(core, "/_serverFn/projects.delete", {
      token,
      csrfCookie: csrf,
      csrfHeader: csrf,
      body: { id: row.id },
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ ok: true });

    const remaining = await db.select().from(projects);
    expect(remaining.some((p) => p.id === row.id)).toBe(false);

    const audit = await auditRows("projects", "projects.delete");
    expect(audit.length).toBeGreaterThanOrEqual(1);
  });
});
