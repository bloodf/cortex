// @vitest-environment node
/**
 * audit-events-result.test.ts — regression for the Audit UI "everything is
 * green" bug. safeAudit stores the request outcome in the audit_log JSONB
 * payload (payload.result ∈ success|failure|denied, payload.errorCode = kind),
 * because audit_log has no dedicated result column. listAuditEvents must
 * recover those from the payload instead of hardcoding result="success".
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDb, type PgliteDbClient } from "../../test-utils";
import { appendAuditLog } from "../audit";
import { listAuditEvents } from "../audit_events";

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

async function append(result: string, errorCode?: string) {
  await appendAuditLog(db, {
    eventType: "incus.stop",
    source: "incus",
    subject: "hermes-canary",
    actor: "1",
    payload: { result, ...(errorCode ? { errorCode } : {}) },
  });
}

describe("listAuditEvents result projection (durable-audit-2)", () => {
  it("recovers denied/failure/success from the payload (not hardcoded success)", async () => {
    await append("success");
    await append("failure");
    await append("denied", "permission");

    const { rows } = await listAuditEvents(db, { surface: "incus" });
    const byResult = Object.fromEntries(rows.map((r) => [r.payload.result, r]));

    expect(byResult.success.result).toBe("success");
    expect(byResult.failure.result).toBe("failure");
    expect(byResult.denied.result).toBe("denied");
    // errorCode is recovered too (was hardcoded null).
    expect(byResult.denied.errorCode).toBe("permission");
  });

  it("falls back to success for an unknown/absent result value", async () => {
    await append("weird-value");
    const { rows } = await listAuditEvents(db, { surface: "incus" });
    expect(rows[0].result).toBe("success");
  });
});
