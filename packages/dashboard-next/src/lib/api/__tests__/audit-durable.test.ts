// @vitest-environment node
/**
 * 0.4 — Durable audit log. Proves the gate pipeline's `safeAudit` DUAL-WRITES:
 * it keeps the in-memory ring (chain-math tests depend on it) AND now also
 * appends a hash-chained row to the Postgres `audit_log` table (the same table
 * the Audit UI reads via `approvals.functions.ts` listAudit).
 *
 * Driven end-to-end through the REAL pipeline (`defineApiRoute`) against a
 * pglite DB injected via `setDbForTests`. Hermetic: in-memory session store +
 * FakePam, pinned HMAC key. The durable write is best-effort, so the harness
 * must explicitly `await flushDurableAudit()` before asserting on DB rows.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from "vitest";

import {
  InMemorySessionStore,
  setSessionStore,
  resetSessionStore,
  generateSessionToken,
} from "@/server/auth/session-store";
import {
  FakePamAuthenticator,
  setPamAuthenticator,
  resetPamAuthenticator,
} from "@/server/auth/pam";
import { SESSION_COOKIE, CSRF_COOKIE, setServerHmacKeyFromString } from "@/server/config";
import {
  defineApiRoute,
  resetRateLimitBuckets,
  flushDurableAudit,
  type ApiRouteCore,
} from "@/server/server-fn-pipeline";
import { resetRevealGrants, grantReveal } from "@/server/env-reveal";
import { setDbForTests, resetDbForTests } from "@/server/db/client";
import { createTestDb, type PgliteDbClient } from "@/server/db/test-utils";
import { auditLog } from "@/server/db/schema";
import { verifyAuditLogChain } from "@/server/db/repos/audit";
import { updateEnvGateOptions } from "../env-browser.functions";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let store: InMemorySessionStore;
let pam: FakePamAuthenticator;
let db: PgliteDbClient;
let client: Awaited<ReturnType<typeof createTestDb>>["client"];

beforeAll(() => {
  setServerHmacKeyFromString("audit-durable-deterministic-key-0123456789abcdef");
});

beforeEach(async () => {
  resetSessionStore();
  store = new InMemorySessionStore();
  setSessionStore(store);
  resetPamAuthenticator();
  pam = new FakePamAuthenticator();
  setPamAuthenticator(pam);
  resetRateLimitBuckets();
  resetRevealGrants();

  const made = await createTestDb({ seed: true });
  db = made.db;
  client = made.client;
  setDbForTests(db);
});

afterEach(async () => {
  resetRevealGrants();
  await flushDurableAudit();
  await client.close();
  resetDbForTests();
});

// ---------------------------------------------------------------------------
// Helpers (copied from security-gate.test.ts — same session/CSRF harness)
// ---------------------------------------------------------------------------

function cookieHeader(parts: Record<string, string>): string {
  return Object.entries(parts)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("; ");
}

async function makeSession(opts: {
  username?: string;
  isAdmin: boolean;
  csrf?: string;
}): Promise<{ token: string; csrf: string; sessionId: string }> {
  const csrf = opts.csrf ?? generateSessionToken();
  const res = await store.createSession({
    username: opts.username ?? (opts.isAdmin ? "admin" : "alice"),
    csrfToken: csrf,
    ip: "127.0.0.1",
    userAgent: "vitest",
    isAdmin: opts.isAdmin,
  });
  return { token: res.token, csrf, sessionId: String(res.session.id) };
}

function post(
  core: ApiRouteCore,
  path: string,
  opts: {
    token?: string;
    csrfCookie?: string;
    csrfHeader?: string;
    body?: unknown;
  } = {},
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

// ---------------------------------------------------------------------------
// 1. Durable dual-write through the real gate
// ---------------------------------------------------------------------------

describe("[0.4] durable audit — gate dual-write to audit_log", () => {
  // A tiny benign admin gate built from the same defineApiRoute the shipped
  // gates use — the durable sink is in safeAudit, so any gate exercises it.
  const benignCore: ApiRouteCore = defineApiRoute({
    methods: ["POST"],
    auth: "admin",
    surface: "test",
    action: "test.act",
    target: () => "res-1",
    handler: async () => ({ ok: true }),
  });

  it("writes a hash-chained row mirroring the in-memory audit; chain verifies", async () => {
    const { token, csrf, sessionId } = await makeSession({ isAdmin: true });
    const res = await post(benignCore, "/_serverFn/test.act", {
      token,
      csrfCookie: csrf,
      csrfHeader: csrf,
    });
    expect(res.status).toBe(201);

    await flushDurableAudit();

    const rows = await db.select().from(auditLog);
    const row = rows.find((r) => r.source === "test" && r.eventType === "test.act");
    expect(row).toBeDefined();
    expect(row!.actor).not.toBeNull();
    // actor is the session id (no numeric user id on a fake PAM session).
    expect(row!.actor).toBe(sessionId);
    expect(row!.subject).toBe("res-1");

    // The read path (listAudit) reads payload.result for the result filter.
    const payload = row!.payload as Record<string, unknown>;
    expect(payload.result).toBe("success");

    const chain = await verifyAuditLogChain(db);
    expect(chain.valid).toBe(true);
  });

  it("surfaces the event through the same DB query the listAudit RPC uses", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    await post(benignCore, "/_serverFn/test.act", { token, csrfCookie: csrf, csrfHeader: csrf });
    await flushDurableAudit();

    // listAudit filters on auditLog.source / auditLog.eventType / payload.result;
    // assert via the same columns (gate options for listAudit are not exported).
    const rows = await db.select().from(auditLog);
    const matching = rows.filter(
      (r) =>
        r.source === "test" &&
        r.eventType === "test.act" &&
        (r.payload as Record<string, unknown>).result === "success",
    );
    expect(matching.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// 2. updateEnv attribution — hashed before/after, NEVER cleartext
// ---------------------------------------------------------------------------

describe("[0.4] updateEnv durable attribution — hash + length only", () => {
  const updateEnvCore: ApiRouteCore = defineApiRoute({
    methods: [updateEnvGateOptions.method],
    ...updateEnvGateOptions,
  });

  // Real files in an isolated, explicitly configured allowlisted root.
  let tmpDir: string;
  let envFile: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "audit-durable-test-"));
    vi.stubEnv("CORTEX_SECRETS_DIR", tmpDir);
    vi.stubEnv("CORTEX_ROOT", join(tmpDir, "installation"));
    envFile = join(tmpDir, "test.env");
    writeFileSync(envFile, "DB_PASSWORD=oldsecret\nDB_HOST=127.0.0.1\n", "utf-8");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("records sha256(old)/sha256(new) + lengths; NO cleartext in the payload", async () => {
    const { token, csrf, sessionId } = await makeSession({ isAdmin: true });
    // updateEnv requires a live reveal grant bound to this session.
    grantReveal(sessionId);

    const NEW_VALUE = "brand-new-secret-value";
    const res = await post(updateEnvCore, "/_serverFn/env-browser.update", {
      token,
      csrfCookie: csrf,
      csrfHeader: csrf,
      body: { path: envFile, key: "DB_PASSWORD", value: NEW_VALUE },
    });
    expect(res.status).toBe(201);

    await flushDurableAudit();

    const rows = await db.select().from(auditLog);
    const attribution = rows.find((r) => r.eventType === "env-browser.update.value");
    expect(attribution).toBeDefined();
    expect(attribution!.source).toBe("env-browser");
    expect(attribution!.subject).toBe(`${envFile} (DB_PASSWORD)`);

    const payload = attribution!.payload as Record<string, unknown>;
    const hex64 = /^[0-9a-f]{64}$/;
    expect(payload.oldHash).toMatch(hex64);
    expect(payload.newHash).toMatch(hex64);
    expect(payload.oldHash).toBe(createHash("sha256").update("oldsecret").digest("hex"));
    expect(payload.newHash).toBe(createHash("sha256").update(NEW_VALUE).digest("hex"));
    expect(payload.oldLen).toBe("oldsecret".length);
    expect(payload.newLen).toBe(NEW_VALUE.length);

    // Hard property: no cleartext value anywhere in the row JSON.
    const rowJson = JSON.stringify(attribution);
    expect(rowJson).not.toContain("oldsecret");
    expect(rowJson).not.toContain(NEW_VALUE);

    const chain = await verifyAuditLogChain(db);
    expect(chain.valid).toBe(true);
  });
});
