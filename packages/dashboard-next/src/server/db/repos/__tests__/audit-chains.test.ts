// @vitest-environment node
/**
 * audit-repo-chains.test.ts — additional coverage of audit.ts.
 *
 * Targets the branches not hit by the existing audit.test.ts:
 *   - jcs: arrays, nested objects, primitives
 *   - verifyAuditLogChain: chain_hash_mismatch tamper, fromTs anchor
 *   - appendAuditLog: validation errors (missing eventType, source, payload)
 *   - GENESIS_PREV_HASH export shape
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
  const r = await createTestDb({ seed: true });
  db = r.db;
  client = r.client;
}, 30_000);

afterEach(async () => {
  if (client) await client.close();
});

describe("jcs — JSON Canonicalization Scheme", () => {
  it("produces empty object for empty input", () => {
    expect(jcs({})).toBe("{}");
  });
  it("produces empty array for empty array", () => {
    expect(jcs([])).toBe("[]");
  });
  it("sorts keys alphabetically at every level", () => {
    const out = jcs({ z: 1, a: { y: 2, b: 3 } });
    expect(out).toBe('{"a":{"b":3,"y":2},"z":1}');
  });
  it("handles primitives at the top level", () => {
    expect(jcs(null)).toBe("null");
    expect(jcs("x")).toBe('"x"');
    expect(jcs(42)).toBe("42");
    expect(jcs(true)).toBe("true");
  });
  it("handles arrays of mixed types", () => {
    expect(jcs([1, "two", null, true])).toBe('[1,"two",null,true]');
  });
  it("handles nested arrays", () => {
    expect(
      jcs([
        [1, 2],
        [3, 4],
      ]),
    ).toBe("[[1,2],[3,4]]");
  });
});

describe("appendAuditLog — input validation", () => {
  it("throws on empty eventType", async () => {
    await expect(
      appendAuditLog(db, {
        eventType: "",
        source: "test",
        payload: { a: 1 },
      }),
    ).rejects.toThrow(/eventType required/);
  });
  it("throws on empty source", async () => {
    await expect(
      appendAuditLog(db, {
        eventType: "x",
        source: "",
        payload: { a: 1 },
      }),
    ).rejects.toThrow(/source required/);
  });
  it("throws on undefined payload", async () => {
    await expect(
      appendAuditLog(db, {
        eventType: "x",
        source: "test",
        payload: undefined,
      }),
    ).rejects.toThrow(/payload required/);
  });
  it("throws on null payload", async () => {
    await expect(
      appendAuditLog(db, {
        eventType: "x",
        source: "test",
        payload: null,
      }),
    ).rejects.toThrow(/payload required/);
  });
  it("accepts a custom eventId", async () => {
    const customId = "11111111-2222-3333-4444-555555555555";
    const row = await appendAuditLog(db, {
      eventId: customId,
      eventType: "test",
      source: "test",
      payload: { a: 1 },
    });
    expect(row.eventId).toBe(customId);
  });
  it("accepts subject and actor", async () => {
    const row = await appendAuditLog(db, {
      eventType: "test",
      source: "test",
      subject: "svc-1",
      actor: "user-1",
      payload: { a: 1 },
    });
    expect(row.subject).toBe("svc-1");
    expect(row.actor).toBe("user-1");
  });
});

describe("verifyAuditLogChain — chain_hash_mismatch detection", () => {
  it("detects a tampered chain_hash", async () => {
    await appendAuditLog(db, {
      eventType: "t",
      source: "s",
      payload: { a: 1 },
    });
    // Tamper the chain_hash directly. The payload_hash and prev_hash
    // remain valid, but the chain_hash (which combines the two) will
    // not match the recomputed value.
    await db.execute(
      sql`UPDATE audit_log SET chain_hash = '0000000000000000000000000000000000000000000000000000000000000000'`,
    );
    const res = await verifyAuditLogChain(db);
    expect(res.valid).toBe(false);
    if (!res.valid) {
      expect(res.brokenAt.reason).toBe("chain_hash_mismatch");
    }
  });
});

describe("verifyAuditLogChain — fromTs anchor", () => {
  it("returns valid when window is empty", async () => {
    await appendAuditLog(db, {
      eventType: "t",
      source: "s",
      payload: { a: 1 },
    });
    // Ask for a window in the distant future.
    const res = await verifyAuditLogChain(db, {
      fromTs: new Date(Date.now() + 60_000),
    });
    expect(res.valid).toBe(true);
    expect(res.count).toBe(0);
  });
  it("reports the correct firstId / lastId on success", async () => {
    await appendAuditLog(db, {
      eventType: "t",
      source: "s",
      payload: { a: 1 },
    });
    await appendAuditLog(db, {
      eventType: "t",
      source: "s",
      payload: { a: 2 },
    });
    await appendAuditLog(db, {
      eventType: "t",
      source: "s",
      payload: { a: 3 },
    });
    const res = await verifyAuditLogChain(db);
    expect(res.valid).toBe(true);
    if (res.valid) {
      expect(res.count).toBe(3);
      expect(res.firstId).toBe(1);
      expect(res.lastId).toBe(3);
    }
  });
});

describe("auditLog — schema sanity", () => {
  it("the audit_log table has the expected columns", async () => {
    const rows = await db.execute<{ column_name: string }>(
      sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'audit_log' ORDER BY column_name`,
    );
    const cols = (rows as unknown as { rows: { column_name: string }[] }).rows.map(
      (r) => r.column_name,
    );
    expect(cols).toContain("id");
    expect(cols).toContain("event_id");
    expect(cols).toContain("event_type");
    expect(cols).toContain("source");
    expect(cols).toContain("subject");
    expect(cols).toContain("actor");
    expect(cols).toContain("payload_hash");
    expect(cols).toContain("prev_hash");
    expect(cols).toContain("chain_hash");
    expect(cols).toContain("payload");
    expect(cols).toContain("occurred_at");
  });
});

describe("GENESIS_PREV_HASH — exported", () => {
  it("is the zero hash (64 hex chars)", async () => {
    const { GENESIS_PREV_HASH } = await import("../audit");
    expect(GENESIS_PREV_HASH).toBe("0".repeat(64));
  });
});

describe("auditLog — roundtrip + select", () => {
  it("selecting the auditLog table returns the inserted row", async () => {
    await appendAuditLog(db, {
      eventType: "e",
      source: "s",
      payload: { a: 1 },
    });
    const rows = await db.select().from(auditLog);
    expect(rows.length).toBe(1);
    expect(rows[0].eventType).toBe("e");
  });
});
