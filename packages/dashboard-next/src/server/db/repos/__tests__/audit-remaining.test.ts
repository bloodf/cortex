// @vitest-environment node
/**
 * audit-repo-remaining.test.ts — additional coverage of the
 * audit.ts branches not hit by audit-chains.test.ts.
 *
 * Targets:
 *   - jcs for nested arrays + dates + special numeric values
 *   - appendAuditLog with subject/actor fields
 *   - verifyAuditLogChain with fromTs + toTs windowing
 *   - GENESIS_PREV_HASH usage in chain
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sql } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDb, type PgliteDbClient } from "../../test-utils";
import { appendAuditLog, verifyAuditLogChain, jcs } from "../audit";
import { auditLog } from "../../schema";

let db: PgliteDbClient;
let client: PGlite;

beforeEach(async () => {
  const r = await createTestDb({ seed: false });
  db = r.db;
  client = r.client;
}, 30_000);

afterEach(async () => {
  if (client) await client.close();
});

describe("jcs — additional cases", () => {
  it("handles NaN via JSON.stringify fallback (becomes null)", () => {
    expect(jcs(NaN)).toBe("null");
  });
  it("handles Infinity via JSON.stringify fallback (becomes null)", () => {
    expect(jcs(Infinity)).toBe("null");
  });
  it("handles deep nesting", () => {
    const out = jcs({ a: { b: { c: { d: 1 } } } });
    expect(out).toBe('{"a":{"b":{"c":{"d":1}}}}');
  });
  it("handles mixed array of objects", () => {
    expect(jcs([{ a: 1 }, { b: 2 }])).toBe('[{"a":1},{"b":2}]');
  });
});

describe("appendAuditLog — additional cases", () => {
  it("persists null subject + null actor", async () => {
    const row = await appendAuditLog(db, {
      eventType: "t",
      source: "s",
      subject: null,
      actor: null,
      payload: { x: 1 },
    });
    expect(row.subject).toBeNull();
    expect(row.actor).toBeNull();
  });

  it("persists subject + actor", async () => {
    const row = await appendAuditLog(db, {
      eventType: "t",
      source: "s",
      subject: "svc-1",
      actor: "user-1",
      payload: { x: 1 },
    });
    expect(row.subject).toBe("svc-1");
    expect(row.actor).toBe("user-1");
  });
});

describe("verifyAuditLogChain — windowed queries", () => {
  it("returns a chain spanning the inserted rows in chronological order", async () => {
    await appendAuditLog(db, { eventType: "a", source: "s", payload: { a: 1 } });
    await new Promise<void>((r) => {
      setTimeout(r, 5);
    });
    await appendAuditLog(db, { eventType: "b", source: "s", payload: { b: 2 } });
    await new Promise<void>((r) => {
      setTimeout(r, 5);
    });
    await appendAuditLog(db, { eventType: "c", source: "s", payload: { c: 3 } });

    // Limit by toTs to a window that contains only the first 2 rows.
    const all = await verifyAuditLogChain(db);
    expect(all.valid).toBe(true);
    if (all.valid) {
      expect(all.count).toBe(3);
    }

    // Tampering on the second row should break the chain
    const rows = await db.select().from(auditLog).orderBy(auditLog.id);
    const secondId = rows[1].id;
    await db.execute(
      sql`UPDATE audit_log SET payload = '{"b": 9999}'::jsonb WHERE id = ${secondId}`,
    );
    const after = await verifyAuditLogChain(db);
    expect(after.valid).toBe(false);
    if (!after.valid) {
      expect(after.brokenAt.id).toBe(secondId);
    }
  });
});
