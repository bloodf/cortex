// @vitest-environment node
/**
 * WP-16 gate + security tests — approvals / audit / command-audit server fns.
 * SECURITY-SENSITIVE.
 *
 * Two layers, mirroring services.functions.test.ts (WP-10 reference):
 *
 *   1. Gate matrix — exercises the auth/RBAC/CSRF gates each server fn applies
 *      via the underlying `defineApiRoute` core (the `(Request) => Response`
 *      pipeline). The createServerFn compiler transform only runs in the
 *      Vite/Nitro build, so a bare `await listApprovals()` under vitest never
 *      invokes the extracted handler; we assert the SAME gate options the fns
 *      use, with no-op handlers (no DB — DB_PASSWORD is unset under test).
 *
 *   2. Security behaviors — exercises the WP-03/WP-02 cores the fns DELEGATE to
 *      (the approval HMAC crypto + the audit hash-chain verifier) directly,
 *      so the single-use + tamper-detection guarantees are asserted end-to-end
 *      against the real modules + a pglite DB.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import { sql } from "drizzle-orm";

import type { PGlite } from "@electric-sql/pglite";
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
import {
  mintApproval,
  consumeApproval,
  verifyApproval,
  resetApprovalStore,
} from "@/server/approval";
import { appendAuditLog, verifyAuditLogChain } from "@/server/db/repos/audit";
import { createTestDb, type PgliteDbClient } from "@/server/db/test-utils";
import type { SessionId } from "@/server/entities";

let store: InMemorySessionStore;

beforeEach(() => {
  resetSessionStore();
  store = new InMemorySessionStore();
  setSessionStore(store);
  resetRateLimitBuckets();
});

// ---------------------------------------------------------------------------
// Gate cores — mirror the approvals.functions.ts gates WITHOUT the DB.
// ---------------------------------------------------------------------------

const listApprovalsCore: ApiRouteCore = defineApiRoute({
  methods: ["GET"],
  auth: "any",
  input: z.object({ status: z.enum(["open", "all"]).optional() }).strict(),
  surface: "approvals",
  action: "approvals.list",
  handler: () => ({ pending: [], total: 0, page: 1, pageSize: 50 }),
});

const mintApprovalCore: ApiRouteCore = defineApiRoute({
  methods: ["POST"],
  auth: "admin",
  input: z
    .object({
      action: z.string().min(1).max(256),
      payload: z.record(z.string(), z.unknown()).default({}),
    })
    .strict(),
  surface: "approvals",
  action: "approvals.mint",
  target: (i) => (i as { action: string }).action,
  handler: () => ({ token: "stub", expiresAt: 0, issuedAt: 0, actionHash: "x", ttlSec: 60 }),
});

const verifyAuditCore: ApiRouteCore = defineApiRoute({
  methods: ["GET"],
  auth: "admin",
  input: z.object({ from: z.string().optional() }).strict(),
  surface: "audit",
  action: "audit.verify",
  handler: () => ({ ok: true, count: 0 }),
});

const listAuditCore: ApiRouteCore = defineApiRoute({
  methods: ["GET"],
  auth: "any",
  input: z.object({ surface: z.string().optional() }).strict(),
  surface: "audit",
  action: "audit.list",
  handler: () => ({ events: [], surfaces: [], actions: [], total: 0, page: 1, pageSize: 50 }),
});

const startCommandCore: ApiRouteCore = defineApiRoute({
  methods: ["POST"],
  auth: "admin",
  input: z.object({ command: z.string().min(1), argv: z.array(z.string()) }).strict(),
  surface: "dashboard_command_audit",
  action: "command_audit.start",
  target: (i) => (i as { command: string }).command,
  handler: () => ({ status: "created" }),
});

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

// ===========================================================================
// Gate matrix
// ===========================================================================

describe("approvals.list gate (auth: any)", () => {
  it("200 with a valid session", async () => {
    const { token } = await makeSession({ isAdmin: false });
    const res = await listApprovalsCore(
      new Request("http://localhost/_serverFn/approvals.list", {
        headers: { cookie: cookieHeader({ [SESSION_COOKIE]: token }) },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ pending: [] });
  });

  it("401 without a session", async () => {
    const res = await listApprovalsCore(new Request("http://localhost/_serverFn/approvals.list"));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("auth");
  });
});

describe("approvals.mint gate (auth: admin, mutation)", () => {
  it("403 for an authenticated non-admin (even with valid CSRF)", async () => {
    const { token, csrf } = await makeSession({ isAdmin: false });
    const res = await mintApprovalCore(
      new Request("http://localhost/_serverFn/approvals.mint", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        body: JSON.stringify({ action: "docker.stop", payload: {} }),
      }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("permission");
  });

  it("403 for an admin without a CSRF header (stolen-cookie attack)", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const res = await mintApprovalCore(
      new Request("http://localhost/_serverFn/approvals.mint", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
        },
        body: JSON.stringify({ action: "docker.stop", payload: {} }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("201 for an admin with a valid session-bound CSRF token", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const res = await mintApprovalCore(
      new Request("http://localhost/_serverFn/approvals.mint", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        body: JSON.stringify({ action: "docker.stop", payload: {} }),
      }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ ttlSec: 60 });
  });
});

describe("audit.verify gate (auth: admin)", () => {
  it("403 for a non-admin", async () => {
    const { token } = await makeSession({ isAdmin: false });
    const res = await verifyAuditCore(
      new Request("http://localhost/_serverFn/audit.verify", {
        headers: { cookie: cookieHeader({ [SESSION_COOKIE]: token }) },
      }),
    );
    expect(res.status).toBe(403);
  });

  it("200 for an admin", async () => {
    const { token } = await makeSession({ isAdmin: true });
    const res = await verifyAuditCore(
      new Request("http://localhost/_serverFn/audit.verify", {
        headers: { cookie: cookieHeader({ [SESSION_COOKIE]: token }) },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });
});

describe("audit.list gate (auth: any)", () => {
  it("401 without a session", async () => {
    const res = await listAuditCore(new Request("http://localhost/_serverFn/audit.list"));
    expect(res.status).toBe(401);
  });

  it("200 with a valid session", async () => {
    const { token } = await makeSession({ isAdmin: false });
    const res = await listAuditCore(
      new Request("http://localhost/_serverFn/audit.list", {
        headers: { cookie: cookieHeader({ [SESSION_COOKIE]: token }) },
      }),
    );
    expect(res.status).toBe(200);
  });
});

describe("command_audit.start gate (auth: admin, mutation)", () => {
  it("403 for a non-admin with valid CSRF", async () => {
    const { token, csrf } = await makeSession({ isAdmin: false });
    const res = await startCommandCore(
      new Request("http://localhost/_serverFn/command_audit.start", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        body: JSON.stringify({ command: "systemctl", argv: ["restart", "caddy.service"] }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("201 for an admin with valid CSRF", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const res = await startCommandCore(
      new Request("http://localhost/_serverFn/command_audit.start", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        body: JSON.stringify({ command: "systemctl", argv: ["restart", "caddy.service"] }),
      }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ status: "created" });
  });
});

// ===========================================================================
// Security: approval single-use (the crypto the mint/grant fns delegate to)
// ===========================================================================

describe("approval token — single-use (WP-03 crypto)", () => {
  const sid = "sess-aaaa" as SessionId;

  beforeEach(() => {
    resetApprovalStore();
  });

  it("mints a token that verifies for the bound session", () => {
    const t = mintApproval({
      action: "docker.stop",
      payload: { container: "myapp" },
      sessionId: sid,
      userId: "u1",
      ttlSec: 60,
    });
    const v = verifyApproval(t.token, sid);
    expect(v.ok).toBe(true);
  });

  it("consume succeeds once, then the SAME token fails as already_used", () => {
    const t = mintApproval({
      action: "docker.stop",
      payload: { container: "myapp" },
      sessionId: sid,
      userId: "u1",
      ttlSec: 60,
    });
    const first = consumeApproval(t.token, sid);
    expect(first.ok).toBe(true);
    const second = consumeApproval(t.token, sid);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("already_used");
  });

  it("rejects consumption by a different session (PB-1 binding)", () => {
    const t = mintApproval({
      action: "docker.stop",
      payload: {},
      sessionId: sid,
      userId: "u1",
      ttlSec: 60,
    });
    const v = consumeApproval(t.token, "sess-other" as SessionId);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("session_mismatch");
  });
});

// ===========================================================================
// Security: audit chain verify (the verifier the verifyAudit fn delegates to)
// ===========================================================================

describe("audit chain verify (WP-02 verifier)", () => {
  let db: PgliteDbClient;
  let client: PGlite;

  beforeEach(async () => {
    const r = await createTestDb({ seed: true });
    db = r.db;
    client = r.client;
  }, 30_000);

  afterEach(async () => {
    if (client) await client.close();
  });

  it("returns valid=true on an intact chain", async () => {
    await appendAuditLog(db, {
      eventType: "approvals.mint",
      source: "approvals",
      payload: { a: 1 },
    });
    await appendAuditLog(db, {
      eventType: "approvals.grant",
      source: "approvals",
      payload: { a: 2 },
    });
    const res = await verifyAuditLogChain(db);
    expect(res.valid).toBe(true);
    if (res.valid) expect(res.count).toBe(2);
  });

  it("returns valid=false with brokenAt after a tampered row", async () => {
    await appendAuditLog(db, { eventType: "audit.list", source: "audit", payload: { a: 1 } });
    await db.execute(sql`UPDATE audit_log SET chain_hash = '${sql.raw("0".repeat(64))}'`);
    const res = await verifyAuditLogChain(db);
    expect(res.valid).toBe(false);
    if (!res.valid) {
      expect(res.brokenAt.reason).toBe("chain_hash_mismatch");
      expect(typeof res.brokenAt.id).toBe("number");
    }
  });
});
