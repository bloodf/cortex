/**
 * Test utilities for the dashboard data layer.
 *
 * Two paths:
 *
 *   1. **In-memory PGlite** (`createTestDb`) — fast, no Docker, runs the
 *      actual SQL migrations. Use for unit + integration tests in
 *      `__tests__/`. The DB is destroyed when the test finishes
 *      (call `await client.close()` in `afterEach`).
 *
 *   2. **Container Postgres** (opt-in) — for full prod-parity tests
 *      that need TimescaleDB. Spun up via the test runner's Docker
 *      compose; this file only provides the wiring.
 *
 * Choice rationale:
 *   The CortexOS schema is PG-flavored (JSONB, INET, arrays, CHECK
 *   constraints, partial indexes). better-sqlite3 would not exercise
 *   the real migrations. PGlite is a real Postgres engine compiled
 *   to WASM that runs the same SQL the prod runner applies. Tests
 *   are therefore faithful to production schema and behaviour.
 *
 * Migration runner: `runSqlMigrations` from `../migrate.ts` is invoked
 * once per test setup. The runner records every filename in the
 * `migrations` table on a fresh DB, so re-runs are no-ops.
 */

import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { createMigratedPgliteDb, type PgliteDbClient } from "./client.pglite";
import * as schema from "./schema";

export type { PgliteDbClient };

/**
 * Deterministic seed data for unit tests. Every test starts from a
 * known state. The seeds are intentionally minimal — tests should
 * add their own data on top.
 */
export const deterministicSeed = {
  services: [
    {
      slug: "postgresql",
      name: "PostgreSQL",
      kind: "service",
      category: "Database",
      healthType: "tcp",
      healthUrl: "tcp://127.0.0.1:5432",
      openUrl: "#",
      iconType: "postgresql",
      sortOrder: 1,
    },
    {
      slug: "caddy",
      name: "Caddy",
      kind: "service",
      category: "Infrastructure",
      healthType: "systemd",
      healthUrl: "caddy",
      openUrl: "#",
      iconType: "caddy",
      sortOrder: 1,
    },
    {
      slug: "grafana",
      name: "Grafana",
      kind: "service",
      category: "Monitoring",
      healthType: "http",
      healthUrl: "http://127.0.0.1:3000/api/health",
      openUrl: "https://grafana.example.com/",
      iconType: "monitor",
      sortOrder: 1,
    },
  ],
  users: [{ username: "admin" }, { username: "operator" }],
} as const;

/**
 * Insert the canonical seed rows. Idempotent (uses ON CONFLICT DO NOTHING
 * semantics via slug lookups). Tests can add more on top.
 */
export async function seedTestDb(db: PgliteDbClient): Promise<void> {
  await Promise.all(
    deterministicSeed.services.map((s) =>
      db
        .insert(schema.services)
        .values(s)
        .onConflictDoUpdate({
          target: schema.services.slug,
          set: { name: s.name, updatedAt: new Date() },
        }),
    ),
  );
  await Promise.all(
    deterministicSeed.users.map((u) => db.insert(schema.pamUsers).values(u).onConflictDoNothing()),
  );
}

/**
 * Build a fresh in-memory PGlite, run all SQL migrations against it,
 * apply `deterministicSeed`, and return the Drizzle client + the
 * PGlite instance + the migration names that were applied.
 *
 * The returned `client` (PGlite) is the raw driver. Tests typically
 * only need `db`; the `client` is exposed so `afterEach` can call
 * `await client.close()` to free the WASM instance.
 */
export async function createTestDb(
  options: {
    /** Override the migrations directory (default: dashboard/migrations). */
    migrationsDir?: string;
    /** Apply `deterministicSeed` after migrations (default: true). */
    seed?: boolean;
  } = {},
): Promise<{
  db: PgliteDbClient;
  client: PGlite;
  ran: string[];
  migrationsDir: string;
}> {
  const migrationsDir = options.migrationsDir ?? join(process.cwd(), "migrations");
  const { db, client, ran } = await createMigratedPgliteDb(migrationsDir);
  if (options.seed !== false) {
    await seedTestDb(db);
  }
  return { db, client, ran, migrationsDir };
}

/**
 * Reset the test DB to a known state by deleting all rows from every
 * table. Faster than rebuilding PGlite for tests that mutate the
 * schema-mutating set but need a clean baseline.
 */
export async function resetTestDb(db: PgliteDbClient): Promise<void> {
  // Order matters: child tables before parents.
  await db.delete(schema.dashboardCommandAudit);
  await db.delete(schema.actionLog);
  await db.delete(schema.alertHistory);
  await db.delete(schema.alertRules);
  await db.delete(schema.alerts);
  await db.delete(schema.agentGatewayAudit);
  await db.delete(schema.auditLog);
  await db.delete(schema.serviceHealthLog);
  await db.delete(schema.serviceBadges);
  await db.delete(schema.messagingRoutes);
  await db.delete(schema.projects);
  await db.delete(schema.chatSessions);
  await db.delete(schema.dashboardLayouts);
  await db.delete(schema.adminSessions);
  await db.delete(schema.pamUsers);
  await db.delete(schema.config);
  await db.delete(schema.services);
  await db.delete(schema.badges);
}
