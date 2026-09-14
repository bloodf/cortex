// @vitest-environment node
/**
 * WP-15 gate tests — mail-guardian server fn security gates.
 *
 * Like `services.functions.test.ts`, this exercises the gate via the
 * underlying `defineApiRoute` core (the `(Request) => Response` pipeline) —
 * the createServerFn compiler transform only runs in the Vite/Nitro build,
 * so a bare `await listAccounts()` under vitest never invokes the extracted
 * handler. Here we assert the auth/RBAC/CSRF matrix the mail-guardian gates
 * apply, using the SAME options the server fns use, WITHOUT touching the DB
 * (handlers that would hit the DB are replaced with a no-op so the gate,
 * not the repo, is asserted — DB_PASSWORD is unset under test).
 *
 * Also includes a node-env gate test: verifies that DB_PASSWORD being unset
 * (the standard test environment) does not affect gate logic — the security
 * pipeline runs independently of the database.
 *
 * Patterns copied from services.functions.test.ts (WP-10 reference).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";

import {
  InMemorySessionStore,
  setSessionStore,
  resetSessionStore,
  generateSessionToken,
} from "@/server/auth/session-store";
import { SESSION_COOKIE, CSRF_COOKIE } from "@/server/config";
import {
  defineApiRoute,
  resetRateLimitBuckets,
  type ApiRouteCore,
} from "@/server/server-fn-pipeline";

let store: InMemorySessionStore;

beforeEach(() => {
  resetSessionStore();
  store = new InMemorySessionStore();
  setSessionStore(store);
  resetRateLimitBuckets();
});

// ---------------------------------------------------------------------------
// Gate cores — mirror the mail-guardian.functions.ts gates without the DB
// ---------------------------------------------------------------------------

// listAccounts gate: auth 'admin'
const listAccountsCore: ApiRouteCore = defineApiRoute({
  methods: ["GET"],
  auth: "admin",
  input: z.object({}).strict(),
  surface: "mail-guardian",
  action: "mail-guardian.accounts.list",
  handler: () => ({ accounts: [] }),
});

// createAccount gate: auth 'admin'
const createAccountCore: ApiRouteCore = defineApiRoute({
  methods: ["POST"],
  auth: "admin",
  input: z
    .object({
      slug: z.string().trim().min(1).max(64),
      address: z.string().trim().email().max(255),
      host: z.string().trim().min(1).max(255),
      port: z.number().int().min(1).max(65535).default(993),
      secure: z.boolean().default(true),
      username: z.string().trim().min(1).max(255),
      password: z.string().min(1).max(1024),
      inbox: z.string().trim().min(1).max(255).default("INBOX"),
      trashMailbox: z.string().trim().max(255).optional().nullable(),
      reviewMailbox: z.string().trim().min(1).max(255).default("INBOX.Cortex Mail Guardian Review"),
      enabled: z.boolean().default(true),
    })
    .strict(),
  surface: "mail-guardian",
  action: "mail-guardian.accounts.create",
  target: (i) => (i as { slug: string }).slug,
  rateLimit: { limit: 30, windowSec: 60, bucket: "user" },
  handler: () => ({ account: { slug: "test", hasPassword: true } }),
});

// deleteAccount gate: auth 'admin'
const deleteAccountCore: ApiRouteCore = defineApiRoute({
  methods: ["POST"],
  auth: "admin",
  input: z.object({ slug: z.string().trim().min(1).max(64) }).strict(),
  surface: "mail-guardian",
  action: "mail-guardian.accounts.delete",
  target: (i) => i.slug,
  rateLimit: { limit: 30, windowSec: 60, bucket: "user" },
  handler: () => ({ ok: true, slug: "test" }),
});

// listReviews gate: auth 'any'
const listReviewsCore: ApiRouteCore = defineApiRoute({
  methods: ["GET"],
  auth: "any",
  input: z
    .object({
      accountSlug: z.string().min(1).max(64).optional(),
      pendingOnly: z.coerce.boolean().optional(),
      page: z.coerce.number().int().min(1).optional(),
      pageSize: z.coerce.number().int().min(1).max(500).optional(),
    })
    .strict(),
  surface: "mail-guardian",
  action: "mail-guardian.reviews.list",
  handler: () => ({ reviews: [], total: 0, page: 1, pageSize: 50 }),
});

// flagReview gate: auth 'admin'
const flagReviewCore: ApiRouteCore = defineApiRoute({
  methods: ["POST"],
  auth: "admin",
  input: z.object({ id: z.coerce.number().int().positive() }).strict(),
  surface: "mail-guardian",
  action: "mail-guardian.flag",
  target: (i) => String(i.id),
  rateLimit: { limit: 60, windowSec: 60, bucket: "user" },
  handler: () => ({
    id: 1,
    ownerDecision: "spam",
    resolvedAt: new Date().toISOString(),
    approver: "dashboard",
  }),
});

// approveReview gate: auth 'admin'
const approveReviewCore: ApiRouteCore = defineApiRoute({
  methods: ["POST"],
  auth: "admin",
  input: z.object({ id: z.coerce.number().int().positive() }).strict(),
  surface: "mail-guardian",
  action: "mail-guardian.approve",
  target: (i) => String(i.id),
  rateLimit: { limit: 60, windowSec: 60, bucket: "user" },
  handler: () => ({
    id: 1,
    ownerDecision: "keep",
    resolvedAt: new Date().toISOString(),
    approver: "dashboard",
  }),
});

// batch gate: auth 'admin'
const batchCore: ApiRouteCore = defineApiRoute({
  methods: ["POST"],
  auth: "admin",
  input: z
    .object({
      ids: z.array(z.number().int().positive()).min(1).max(500),
      action: z.enum(["approve", "flag"]),
    })
    .strict(),
  surface: "mail-guardian",
  action: "mail-guardian.batch",
  target: (i) => `${(i as { action: string }).action}:${(i as { ids: number[] }).ids.length}`,
  rateLimit: { limit: 30, windowSec: 60, bucket: "user" },
  handler: () => ({ updated: 2, action: "approve" }),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function cookieHeader(parts: Record<string, string>): string {
  return Object.entries(parts)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("; ");
}

// ---------------------------------------------------------------------------
// listAccounts gate (auth: admin)
// ---------------------------------------------------------------------------

describe("mail-guardian.accounts.list gate (auth: admin)", () => {
  it("200 for an admin", async () => {
    const { token } = await makeSession({ isAdmin: true });
    const res = await listAccountsCore(
      new Request("http://localhost/_serverFn/mail-guardian.accounts.list", {
        headers: { cookie: cookieHeader({ [SESSION_COOKIE]: token }) },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ accounts: [] });
  });

  it("401 without a session", async () => {
    const res = await listAccountsCore(
      new Request("http://localhost/_serverFn/mail-guardian.accounts.list"),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("auth");
  });

  it("403 for an authenticated non-admin", async () => {
    const { token } = await makeSession({ isAdmin: false });
    const res = await listAccountsCore(
      new Request("http://localhost/_serverFn/mail-guardian.accounts.list", {
        headers: { cookie: cookieHeader({ [SESSION_COOKIE]: token }) },
      }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("permission");
  });
});

// ---------------------------------------------------------------------------
// createAccount gate (auth: admin, mutation)
// ---------------------------------------------------------------------------

describe("mail-guardian.accounts.create gate (auth: admin, mutation)", () => {
  const validBody = {
    slug: "test-acct",
    address: "test@example.com",
    host: "mail.example.com",
    port: 993,
    secure: true,
    username: "test@example.com",
    password: "secret",
    inbox: "INBOX",
    reviewMailbox: "INBOX.Review",
    enabled: true,
  };

  it("403 for a non-admin (even with valid CSRF)", async () => {
    const { token, csrf } = await makeSession({ isAdmin: false });
    const res = await createAccountCore(
      new Request("http://localhost/_serverFn/mail-guardian.accounts.create", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        body: JSON.stringify(validBody),
      }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("permission");
  });

  it("403 for an admin without a CSRF header (stolen-cookie attack)", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const res = await createAccountCore(
      new Request("http://localhost/_serverFn/mail-guardian.accounts.create", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
        },
        body: JSON.stringify(validBody),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("201 for an admin with a valid session-bound CSRF token", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const res = await createAccountCore(
      new Request("http://localhost/_serverFn/mail-guardian.accounts.create", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        body: JSON.stringify(validBody),
      }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ account: { slug: "test" } });
  });
});

// ---------------------------------------------------------------------------
// deleteAccount gate (auth: admin, mutation)
// ---------------------------------------------------------------------------

describe("mail-guardian.accounts.delete gate (auth: admin, mutation)", () => {
  it("401 without a session", async () => {
    const res = await deleteAccountCore(
      new Request("http://localhost/_serverFn/mail-guardian.accounts.delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: "test-acct" }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("201 for an admin with valid CSRF", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const res = await deleteAccountCore(
      new Request("http://localhost/_serverFn/mail-guardian.accounts.delete", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        body: JSON.stringify({ slug: "test-acct" }),
      }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// listReviews gate (auth: any)
// ---------------------------------------------------------------------------

describe("mail-guardian.reviews.list gate (auth: any)", () => {
  it("200 with a valid session", async () => {
    const { token } = await makeSession({ isAdmin: false });
    const res = await listReviewsCore(
      new Request("http://localhost/_serverFn/mail-guardian.reviews.list", {
        headers: { cookie: cookieHeader({ [SESSION_COOKIE]: token }) },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ reviews: [], total: 0, page: 1, pageSize: 50 });
  });

  it("401 without a session", async () => {
    const res = await listReviewsCore(
      new Request("http://localhost/_serverFn/mail-guardian.reviews.list"),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("auth");
  });

  it("200 for an admin (auth: any accepts admin too)", async () => {
    const { token } = await makeSession({ isAdmin: true });
    const res = await listReviewsCore(
      new Request("http://localhost/_serverFn/mail-guardian.reviews.list", {
        headers: { cookie: cookieHeader({ [SESSION_COOKIE]: token }) },
      }),
    );
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// flagReview gate (auth: admin, mutation)
// ---------------------------------------------------------------------------

describe("mail-guardian.flag gate (auth: admin, mutation)", () => {
  it("403 for a non-admin", async () => {
    const { token, csrf } = await makeSession({ isAdmin: false });
    const res = await flagReviewCore(
      new Request("http://localhost/_serverFn/mail-guardian.flag", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        body: JSON.stringify({ id: 1 }),
      }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("permission");
  });

  it("201 for an admin with valid session-bound CSRF", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const res = await flagReviewCore(
      new Request("http://localhost/_serverFn/mail-guardian.flag", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        body: JSON.stringify({ id: 1 }),
      }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ ownerDecision: "spam" });
  });
});

// ---------------------------------------------------------------------------
// approveReview gate (auth: admin, mutation)
// ---------------------------------------------------------------------------

describe("mail-guardian.approve gate (auth: admin, mutation)", () => {
  it("403 for a non-admin", async () => {
    const { token, csrf } = await makeSession({ isAdmin: false });
    const res = await approveReviewCore(
      new Request("http://localhost/_serverFn/mail-guardian.approve", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        body: JSON.stringify({ id: 1 }),
      }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("permission");
  });

  it("201 for an admin with valid session-bound CSRF", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const res = await approveReviewCore(
      new Request("http://localhost/_serverFn/mail-guardian.approve", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        body: JSON.stringify({ id: 1 }),
      }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ ownerDecision: "keep" });
  });
});

// ---------------------------------------------------------------------------
// batch gate (auth: admin, mutation)
// ---------------------------------------------------------------------------

describe("mail-guardian.batch gate (auth: admin, mutation)", () => {
  it("403 for a non-admin", async () => {
    const { token, csrf } = await makeSession({ isAdmin: false });
    const res = await batchCore(
      new Request("http://localhost/_serverFn/mail-guardian.batch", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        body: JSON.stringify({ ids: [1, 2], action: "approve" }),
      }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("permission");
  });

  it("403 for an admin missing CSRF header", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const res = await batchCore(
      new Request("http://localhost/_serverFn/mail-guardian.batch", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
        },
        body: JSON.stringify({ ids: [1, 2], action: "approve" }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("201 for an admin with valid session-bound CSRF", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const res = await batchCore(
      new Request("http://localhost/_serverFn/mail-guardian.batch", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        body: JSON.stringify({ ids: [1, 2], action: "approve" }),
      }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ updated: 2, action: "approve" });
  });

  it("400 on invalid input (empty ids array)", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const res = await batchCore(
      new Request("http://localhost/_serverFn/mail-guardian.batch", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        body: JSON.stringify({ ids: [], action: "approve" }),
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("validation");
  });
});

// ---------------------------------------------------------------------------
// Node-env gate: DB_PASSWORD unset does not affect gate security
// ---------------------------------------------------------------------------

describe("node-env gate: security holds regardless of DB state", () => {
  // (Removed a brittle `expect(process.env.DB_PASSWORD).toBeUndefined()`
  // assertion — it tested the ambient env, not behavior, and broke when the
  // suite is run with live DB creds sourced. The gate tests below are the
  // real contract: auth/RBAC enforce before any DB access.)
  it("auth gate rejects unauthenticated requests regardless of DB_PASSWORD", async () => {
    // With DB_PASSWORD unset, the security gates still enforce auth
    // (they run in the session store, not the DB).
    const res = await listAccountsCore(
      new Request("http://localhost/_serverFn/mail-guardian.accounts.list"),
    );
    expect(res.status).toBe(401);
  });

  it("admin gate rejects non-admin regardless of DB_PASSWORD", async () => {
    const { token } = await makeSession({ isAdmin: false });
    const res = await listAccountsCore(
      new Request("http://localhost/_serverFn/mail-guardian.accounts.list", {
        headers: { cookie: cookieHeader({ [SESSION_COOKIE]: token }) },
      }),
    );
    expect(res.status).toBe(403);
  });
});
