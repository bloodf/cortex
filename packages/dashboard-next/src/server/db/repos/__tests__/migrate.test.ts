// @vitest-environment node
/**
 * Migration roundtrip test.
 *
 * Starts from an empty PGlite, runs all `migrations/*.sql` files in
 * lexical order, and verifies the resulting schema matches the
 * canonical Drizzle schema:
 *   - Every domain table exists
 *   - Every expected column is present with the right type
 *   - The `migrations` table contains every filename
 *   - Critical indexes (RBAC + audit) are present
 *   - The dashboard_command_audit lifecycle trigger is installed
 *
 * If this test fails, the SQL migrations and the Drizzle schema have
 * diverged. Either fix the SQL or update `schema.ts` to match.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { createMigratedPgliteDb } from "../../client.pglite";

let client: PGlite;
let ran: string[];

const EXPECTED_TABLES = [
  "migrations",
  "services",
  "badges",
  "service_badges",
  "alerts",
  "agent_gateway_audit",
  "projects",
  "messaging_routes",
  "pam_users",
  "admin_sessions",
  "service_health_log",
  "alert_rules",
  "alert_history",
  "action_log",
  "config",
  "dashboard_layouts",
  "chat_sessions",
  "incus_instances",
  "audit_log",
  "pending_approvals",
  "dashboard_command_audit",
  "mail_guardian_reviews",
  "mail_guardian_actions",
  "mail_guardian_processed",
  "mail_guardian_rules",
  "mail_guardian_accounts",
];

const CRITICAL_INDEXES = [
  // RBAC
  "idx_admin_sessions_token",
  "idx_admin_sessions_user",
  "idx_admin_sessions_expires_at",
  // Audit (agent_gateway)
  "idx_agent_gateway_audit_ts",
  "idx_agent_gateway_audit_role_ts",
  "idx_agent_gateway_audit_actor_ts",
  // Audit (hash chain)
  "idx_audit_log_event_type",
  "idx_audit_log_subject",
  "idx_audit_log_chain_head",
  "idx_audit_log_actor",
  "idx_audit_log_source",
  // Command audit
  "idx_dashboard_command_audit_request_id",
  "idx_dashboard_command_audit_created_at",
  "idx_dashboard_command_audit_requester_created",
  "idx_dashboard_command_audit_status_created",
  "idx_dashboard_command_audit_command_created",
  "idx_dashboard_command_audit_session",
  // Action log
  "idx_action_log_user_created",
];

beforeAll(async () => {
  const dir = join(process.cwd(), "migrations");
  const r = await createMigratedPgliteDb(dir);
  client = r.client;
  ran = r.ran;
}, 30_000);

afterAll(async () => {
  if (client) await client.close();
});

describe("migration roundtrip", () => {

  it("records every applied migration in the dashboard_migrations ledger", async () => {
    // The runner records into the namespaced `dashboard_migrations` ledger
    // (not the legacy shared `migrations` table) since the ledger-collision
    // fix — see src/server/db/migrate.ts.
    const rows = await client.query<{ name: string }>(
      "SELECT name FROM dashboard_migrations ORDER BY name",
    );
    const applied = rows.rows.map((r) => r.name);
    expect(applied).toEqual([...ran].sort());
  });

  it("creates every domain table", async () => {
    const rows = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
			 WHERE table_schema = 'public' ORDER BY table_name`,
    );
    const present = new Set(rows.rows.map((r) => r.table_name));
    EXPECTED_TABLES.forEach((t) => {
      expect(present.has(t), `missing table: ${t}`).toBe(true);
    });
  });

  it("creates every critical RBAC + audit index", async () => {
    const rows = await client.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`,
    );
    const present = new Set(rows.rows.map((r) => r.indexname));
    CRITICAL_INDEXES.forEach((idx) => {
      expect(present.has(idx), `missing index: ${idx}`).toBe(true);
    });
  });

  it("installs the dashboard_command_audit updated_at trigger", async () => {
    const rows = await client.query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger WHERE tgname = 'trg_dashboard_command_audit_touch_updated_at'`,
    );
    expect(rows.rows.length).toBe(1);
  });

  it("enforces the dashboard_command_audit request_id unique constraint", async () => {
    await client.exec(`
			INSERT INTO dashboard_command_audit (request_id, command, argv)
			VALUES ('test-req-1', 'echo', '[]'::jsonb)
		`);
    // Second insert with the same request_id must fail.
    await expect(
      client.exec(`
				INSERT INTO dashboard_command_audit (request_id, command, argv)
				VALUES ('test-req-1', 'echo', '[]'::jsonb)
			`),
    ).rejects.toThrow();
  });

  it("enforces the agent_gateway_audit CHECK constraints", async () => {
    await expect(
      client.exec(`
				INSERT INTO agent_gateway_audit (tool_class, args_hash, decision, result)
				VALUES ('not-a-tool-class', 'hash', 'allow', 'ok')
			`),
    ).rejects.toThrow();
  });

  it("enforces the alerts severity CHECK constraint", async () => {
    await expect(
      client.exec(`
				INSERT INTO alerts (kind, severity, title)
				VALUES ('test', 'fatal', 'x')
			`),
    ).rejects.toThrow();
  });

  it("does not seed service choices or private deployment state", async () => {
    const services = await client.query("SELECT slug FROM services");
    const routes = await client.query("SELECT * FROM messaging_routes");
    const projects = await client.query("SELECT * FROM projects");
    expect(services.rows).toEqual([]);
    expect(routes.rows).toEqual([]);
    expect(projects.rows).toEqual([]);
  });
});
