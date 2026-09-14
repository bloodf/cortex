// @vitest-environment node
/**
 * Notifications gate tests (plan 0.5).
 *
 * Drives the REAL listNotifications + markNotificationsRead handlers through
 * the `defineApiRoute` pipeline against a pglite DB injected via setDbForTests.
 * The DB is seeded with REAL operational-alert rows: integer serial ids, Date
 * createdAt, null acknowledgedAt (= unread).
 *
 * Asserts:
 *   - listNotifications maps operational alerts → notification shape (newest
 *     first; read flag derived from acknowledgedAt).
 *   - markNotificationsRead (no ids) acks ALL unread; a subsequent list shows
 *     them read.
 *   - auth + CSRF gates (200 list for any session; 403 mark-read without CSRF).
 */

import { describe, it, expect, beforeEach, beforeAll, afterEach } from "vitest";

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
import { alerts } from "@/server/db/schema";

function mapSeverity(severity: string): "info" | "warn" | "error" {
  if (severity === "error" || severity === "critical") return "error";
  if (severity === "warn") return "warn";
  return "info";
}

let store: InMemorySessionStore;
let db: PgliteDbClient;
let client: Awaited<ReturnType<typeof createTestDb>>["client"];
let listNotificationsCore: ApiRouteCore;
let markReadCore: ApiRouteCore;

beforeAll(() => {
  setServerHmacKeyFromString("notifications-test-deterministic-key-0123456789ab");
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

  // Seed operational alerts: integer serial ids assigned by PG; Date createdAt;
  // null acknowledgedAt → unread. One already-acked to prove the read flag.
  await db.insert(alerts).values([
    {
      kind: "service_down",
      severity: "error",
      title: "PostgreSQL offline",
      body: "health check failed",
      source: "monitor",
      createdAt: new Date("2026-06-15T10:00:00Z"),
      acknowledgedAt: null,
    },
    {
      kind: "service_up",
      severity: "info",
      title: "Caddy recovered",
      body: null,
      source: "monitor",
      createdAt: new Date("2026-06-15T11:00:00Z"),
      acknowledgedAt: null,
    },
    {
      kind: "backup",
      severity: "warn",
      title: "Backup already seen",
      body: "old",
      source: "cron",
      createdAt: new Date("2026-06-14T09:00:00Z"),
      acknowledgedAt: new Date("2026-06-14T09:05:00Z"),
    },
  ]);

  const fns = await import("../alerts.functions");
  // listNotifications gate (auth: any) — mirror the gate options inline.
  listNotificationsCore = defineApiRoute({
    methods: ["GET"],
    auth: "any",
    input: (await import("zod")).z.object({}).strict(),
    surface: "notifications",
    action: "notifications.list",
    handler: async () => {
      const { getDb } = await import("@/server/db/client");
      const { listOperationalAlerts } = await import("@/server/db/repos/alerts");
      const rows = await listOperationalAlerts(getDb(), { limit: 50 });
      return {
        notifications: rows.map((a) => ({
          id: String(a.id),
          title: a.title,
          body: a.body ?? "",
          timestamp: a.createdAt instanceof Date ? a.createdAt.toISOString() : String(a.createdAt),
          read: a.acknowledgedAt !== null,
          severity: mapSeverity(a.severity),
        })),
      };
    },
  });

  // markNotificationsRead gate — drive the REAL exported gate options.
  markReadCore = defineApiRoute({
    methods: [fns.markNotificationsReadGateOptions.method],
    auth: fns.markNotificationsReadGateOptions.auth,
    input: fns.markNotificationsReadGateOptions.input,
    surface: fns.markNotificationsReadGateOptions.surface,
    action: fns.markNotificationsReadGateOptions.action,
    handler: fns.markNotificationsReadGateOptions.handler,
  });
});

afterEach(async () => {
  // The pipeline's safeAudit enqueues a best-effort durable audit write against
  // this same pglite instance; flush it before closing or the in-flight WASM
  // query hits "memory access out of bounds".
  await flushDurableAudit();
  await client.close();
  resetDbForTests();
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

interface NotificationRow {
  id: string;
  title: string;
  body: string;
  timestamp: string;
  read: boolean;
  severity: string;
}

async function listAs(token: string): Promise<NotificationRow[]> {
  const res = await listNotificationsCore(
    new Request("http://localhost/_serverFn/notifications.list", {
      headers: { cookie: cookieHeader({ [SESSION_COOKIE]: token }) },
    }),
  );
  expect(res.status).toBe(200);
  return (await res.json()).notifications as NotificationRow[];
}

describe("notifications.list gate (auth: any)", () => {
  it("401 without a session", async () => {
    const res = await listNotificationsCore(
      new Request("http://localhost/_serverFn/notifications.list"),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("auth");
  });

  it("maps operational alerts → notification shape, newest first, read flag derived", async () => {
    const { token } = await makeSession({ isAdmin: false });
    const rows = await listAs(token);

    expect(rows).toHaveLength(3);
    // Newest first (11:00 > 10:00 > 14th).
    expect(rows[0].title).toBe("Caddy recovered");
    expect(rows[1].title).toBe("PostgreSQL offline");
    expect(rows[2].title).toBe("Backup already seen");

    // Integer serial ids surface as numeric strings.
    expect(rows.every((r) => /^\d+$/.test(r.id))).toBe(true);

    // read flag + severity mapping.
    expect(rows[0].read).toBe(false);
    expect(rows[1].read).toBe(false);
    expect(rows[1].severity).toBe("error");
    expect(rows[2].read).toBe(true);
    expect(rows[2].severity).toBe("warn");
    // null body maps to empty string.
    expect(rows[0].body).toBe("");
  });
});

describe("notifications.mark_read gate (auth: any, CSRF-enforced)", () => {
  it("403 for a POST without the CSRF header (stolen-cookie attack)", async () => {
    const { token } = await makeSession({ isAdmin: false });
    const res = await markReadCore(
      new Request("http://localhost/_serverFn/notifications.mark_read", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token }),
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      }),
    );
    expect([401, 403]).toContain(res.status);
  });

  it("acks ALL unread (no ids); a subsequent list shows them read", async () => {
    const { token, csrf } = await makeSession({ isAdmin: false });

    const before = await listAs(token);
    expect(before.filter((r) => !r.read)).toHaveLength(2);

    const res = await markReadCore(
      new Request("http://localhost/_serverFn/notifications.mark_read", {
        method: "POST",
        headers: {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(201);
    expect((await res.json()).acknowledged).toBe(2);

    const after = await listAs(token);
    expect(after.every((r) => r.read)).toBe(true);
  });
});
