// @vitest-environment node
/**
 * Audit repository tests.
 *
 * Covers:
 *   - agent_gateway_audit append-only writes (INSERT only — no UPDATE/DELETE)
 *   - list + count with filters
 *   - audit_log hash-chain verification
 *   - audit_log append (chain tip advances)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { runSequentially } from "@/lib/sequential";
import { createTestDb, type PgliteDbClient } from "../../test-utils";
import {
  insertAgentGatewayAudit,
  listAgentGatewayAudit,
  countAgentGatewayAudit,
  verifyAuditLogChain,
  appendAuditLog,
  jcs,
} from "../audit";

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

describe("audit repo — agent_gateway_audit (append-only)", () => {
  it("insertAgentGatewayAudit inserts a row", async () => {
    const row = await insertAgentGatewayAudit(db, {
      toolClass: "safe",
      argsHash: "abc123",
      decision: "allow",
      result: "ok",
    });
    expect(row.id).toBeGreaterThan(0);
    expect(row.argsHash).toBe("abc123");
  });

  it("rejects invalid toolClass", async () => {
    await expect(
      insertAgentGatewayAudit(db, {
        toolClass: "nope" as never,
        argsHash: "x",
        decision: "allow",
        result: "ok",
      }),
    ).rejects.toThrow("Invalid tool_class");
  });

  it("rejects invalid decision", async () => {
    await expect(
      insertAgentGatewayAudit(db, {
        toolClass: "safe",
        argsHash: "x",
        decision: "maybe" as never,
        result: "ok",
      }),
    ).rejects.toThrow("Invalid decision");
  });

  it("rejects invalid result", async () => {
    await expect(
      insertAgentGatewayAudit(db, {
        toolClass: "safe",
        argsHash: "x",
        decision: "allow",
        result: "maybe" as never,
      }),
    ).rejects.toThrow("Invalid result");
  });

  it("rejects empty args_hash", async () => {
    await expect(
      insertAgentGatewayAudit(db, {
        toolClass: "safe",
        argsHash: "",
        decision: "allow",
        result: "ok",
      }),
    ).rejects.toThrow("args_hash is required");
  });

  it("listAgentGatewayAudit filters by toolClass", async () => {
    await insertAgentGatewayAudit(db, {
      toolClass: "safe",
      argsHash: "h1",
      decision: "allow",
      result: "ok",
    });
    await insertAgentGatewayAudit(db, {
      toolClass: "privileged",
      argsHash: "h2",
      decision: "deny",
      result: "denied",
    });
    const safe = await listAgentGatewayAudit(db, { toolClass: "safe" });
    expect(safe.every((r) => r.toolClass === "safe")).toBe(true);
  });

  it("countAgentGatewayAudit returns the count", async () => {
    await Promise.all(
      Array.from({ length: 3 }, (_, i) =>
        insertAgentGatewayAudit(db, {
          toolClass: "safe",
          argsHash: `h${i}`,
          decision: "allow",
          result: "ok",
        }),
      ),
    );
    expect(await countAgentGatewayAudit(db)).toBe(3);
  });
});

describe("audit repo — audit_log hash chain", () => {
  it("jcs produces deterministic output regardless of key order", () => {
    const a = jcs({ b: 2, a: 1 });
    const b = jcs({ a: 1, b: 2 });
    expect(a).toBe(b);
  });

  it("verifyAuditLogChain on an empty table is valid (count 0)", async () => {
    const res = await verifyAuditLogChain(db);
    expect(res.valid).toBe(true);
    expect(res.count).toBe(0);
  });

  it("appendAuditLog + verifyAuditLogChain — single row chain is valid", async () => {
    await appendAuditLog(db, {
      eventType: "test.event",
      source: "test",
      payload: { a: 1, b: 2 },
    });
    const res = await verifyAuditLogChain(db);
    expect(res.valid).toBe(true);
    expect(res.count).toBe(1);
  });

  it("appendAuditLog + verifyAuditLogChain — multiple rows chain correctly", async () => {
    await runSequentially([0, 1, 2, 3, 4], async (i) =>
      appendAuditLog(db, {
        eventType: `test.event.${i}`,
        source: "test",
        payload: { i },
      }),
    );
    const res = await verifyAuditLogChain(db);
    expect(res.valid).toBe(true);
    expect(res.count).toBe(5);
  });

  it("verifyAuditLogChain detects a tampered payload", async () => {
    await appendAuditLog(db, {
      eventType: "test.event",
      source: "test",
      payload: { a: 1 },
    });
    // Tamper with the row directly (simulating a compromised DB)
    // Bypass the repo and use raw SQL.
    const { sql } = await import("drizzle-orm");
    await db.execute(sql`UPDATE audit_log SET payload = '{"a": 999}'::jsonb`);
    const res = await verifyAuditLogChain(db);
    expect(res.valid).toBe(false);
    if (!res.valid) {
      expect(res.brokenAt.reason).toBe("payload_hash_mismatch");
    }
  });

  it("verifyAuditLogChain detects a tampered prev_hash", async () => {
    await appendAuditLog(db, {
      eventType: "test.event",
      source: "test",
      payload: { a: 1 },
    });
    await appendAuditLog(db, {
      eventType: "test.event",
      source: "test",
      payload: { a: 2 },
    });
    const { sql } = await import("drizzle-orm");
    await db.execute(
      sql`UPDATE audit_log SET prev_hash = '0000000000000000000000000000000000000000000000000000000000000000' WHERE id = (SELECT id FROM audit_log ORDER BY id OFFSET 1 LIMIT 1)`,
    );
    const res = await verifyAuditLogChain(db);
    expect(res.valid).toBe(false);
    if (!res.valid) {
      expect(res.brokenAt.reason).toBe("prev_hash_mismatch");
    }
  });

  it("appendAuditLog advances the chain tip with correct prev_hash", async () => {
    await appendAuditLog(db, {
      eventType: "test.event",
      source: "test",
      payload: { a: 1 },
    });
    await appendAuditLog(db, {
      eventType: "test.event",
      source: "test",
      payload: { a: 2 },
    });
    const { auditLog } = await import("../../schema");
    const rows = await db.select().from(auditLog).orderBy(auditLog.id);
    // Second row's prev_hash must equal first row's chain_hash.
    const tip1Hash = rows[0].chainHash;
    const row2Prev = rows[1].prevHash;
    expect(row2Prev).toBe(tip1Hash);
  });
});
