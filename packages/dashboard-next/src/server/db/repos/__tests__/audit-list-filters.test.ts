// @vitest-environment node
/**
 * audit-list-filters.test.ts — additional coverage of
 * listAgentGatewayAudit and countAgentGatewayAudit filter branches
 * not yet exercised by audit.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDb, type PgliteDbClient } from "../../test-utils";
import { insertAgentGatewayAudit, listAgentGatewayAudit, countAgentGatewayAudit } from "../audit";

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

describe("listAgentGatewayAudit — additional filter branches", () => {
  it("filters by actorUserId", async () => {
    await insertAgentGatewayAudit(db, {
      actorUserId: 1,
      toolClass: "safe",
      argsHash: "h1",
      decision: "allow",
      result: "ok",
    });
    await insertAgentGatewayAudit(db, {
      actorUserId: 2,
      toolClass: "safe",
      argsHash: "h2",
      decision: "allow",
      result: "ok",
    });
    const out = await listAgentGatewayAudit(db, { actorUserId: 1 });
    expect(out.every((r) => r.actorUserId === 1)).toBe(true);
  });

  it("filters by role", async () => {
    await insertAgentGatewayAudit(db, {
      role: "admin",
      toolClass: "safe",
      argsHash: "h1",
      decision: "allow",
      result: "ok",
    });
    await insertAgentGatewayAudit(db, {
      role: "user",
      toolClass: "safe",
      argsHash: "h2",
      decision: "allow",
      result: "ok",
    });
    const out = await listAgentGatewayAudit(db, { role: "admin" });
    expect(out.every((r) => r.role === "admin")).toBe(true);
  });

  it("filters by account", async () => {
    await insertAgentGatewayAudit(db, {
      account: "a@x.com",
      toolClass: "safe",
      argsHash: "h1",
      decision: "allow",
      result: "ok",
    });
    const out = await listAgentGatewayAudit(db, { account: "a@x.com" });
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((r) => r.account === "a@x.com")).toBe(true);
  });

  it("filters by tool", async () => {
    await insertAgentGatewayAudit(db, {
      tool: "my.tool",
      toolClass: "safe",
      argsHash: "h1",
      decision: "allow",
      result: "ok",
    });
    const out = await listAgentGatewayAudit(db, { tool: "my.tool" });
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((r) => r.tool === "my.tool")).toBe(true);
  });

  it("filters by decision", async () => {
    await insertAgentGatewayAudit(db, {
      toolClass: "safe",
      argsHash: "h1",
      decision: "deny",
      result: "denied",
    });
    const out = await listAgentGatewayAudit(db, { decision: "deny" });
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((r) => r.decision === "deny")).toBe(true);
  });

  it("filters by result", async () => {
    await insertAgentGatewayAudit(db, {
      toolClass: "safe",
      argsHash: "h1",
      decision: "allow",
      result: "err",
    });
    const out = await listAgentGatewayAudit(db, { result: "err" });
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((r) => r.result === "err")).toBe(true);
  });

  it("throws on invalid toolClass", async () => {
    await expect(listAgentGatewayAudit(db, { toolClass: "garbage" as never })).rejects.toThrow(
      /tool_class/,
    );
  });

  it("throws on invalid decision", async () => {
    await expect(listAgentGatewayAudit(db, { decision: "garbage" as never })).rejects.toThrow(
      /decision/,
    );
  });

  it("throws on invalid result", async () => {
    await expect(listAgentGatewayAudit(db, { result: "garbage" as never })).rejects.toThrow(
      /result/,
    );
  });
});

describe("countAgentGatewayAudit — additional filter branches", () => {
  it("counts filtered by toolClass", async () => {
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
    expect(await countAgentGatewayAudit(db, { toolClass: "safe" })).toBe(1);
  });

  it("counts filtered by actorUserId", async () => {
    await insertAgentGatewayAudit(db, {
      actorUserId: 5,
      toolClass: "safe",
      argsHash: "h1",
      decision: "allow",
      result: "ok",
    });
    expect(await countAgentGatewayAudit(db, { actorUserId: 5 })).toBe(1);
  });

  it("counts filtered by role", async () => {
    await insertAgentGatewayAudit(db, {
      role: "admin",
      toolClass: "safe",
      argsHash: "h1",
      decision: "allow",
      result: "ok",
    });
    expect(await countAgentGatewayAudit(db, { role: "admin" })).toBeGreaterThanOrEqual(1);
  });

  it("counts filtered by account", async () => {
    await insertAgentGatewayAudit(db, {
      account: "b@y.com",
      toolClass: "safe",
      argsHash: "h1",
      decision: "allow",
      result: "ok",
    });
    expect(await countAgentGatewayAudit(db, { account: "b@y.com" })).toBe(1);
  });
});
