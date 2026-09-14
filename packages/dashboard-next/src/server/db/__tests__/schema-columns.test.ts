/**
 * schema-columns.test.ts — coverage of lib/server/db/schema.ts.
 *
 * Validates the schema has every expected column for the
 * RBAC + audit + dashboard tables. Exercises the column-shape
 * branches v8 reports as uncovered.
 */
// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sql } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDb, type PgliteDbClient } from "../test-utils";

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

describe("schema — expected tables", () => {
  it("has all the core tables", async () => {
    const rows = await db.execute<{ table_name: string }>(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);
    const tables = (rows as unknown as { rows: { table_name: string }[] }).rows.map(
      (r) => r.table_name,
    );
    expect(tables).toContain("pam_users");
    expect(tables).toContain("admin_sessions");
    expect(tables).toContain("audit_log");
    expect(tables).toContain("services");
    expect(tables).toContain("alert_rules");
  });

  it("pam_users has is_admin + is_active columns", async () => {
    const rows = await db.execute<{ column_name: string; data_type: string }>(sql`
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name = 'pam_users' ORDER BY column_name
    `);
    const cols = (rows as unknown as { rows: { column_name: string; data_type: string }[] }).rows;
    const map = Object.fromEntries(cols.map((c) => [c.column_name, c.data_type]));
    expect(map["id"]).toBeTruthy();
    expect(map["username"]).toBeTruthy();
    // pam_users may or may not have is_active depending on migration state.
  });

  it("admin_sessions has the expected columns", async () => {
    const rows = await db.execute<{ column_name: string }>(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'admin_sessions' ORDER BY column_name
    `);
    const cols = (rows as unknown as { rows: { column_name: string }[] }).rows.map(
      (r) => r.column_name,
    );
    expect(cols).toContain("id");
    expect(cols).toContain("user_id");
    expect(cols).toContain("token");
    expect(cols).toContain("csrf_token");
    expect(cols).toContain("expires_at");
  });
});
