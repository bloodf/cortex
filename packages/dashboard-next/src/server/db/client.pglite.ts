/**
 * Drizzle client bound to PGlite (in-memory Postgres in WASM).
 *
 * Use only in tests. PGlite is a real Postgres engine compiled to WASM —
 * JSONB, INET, TIMESTAMPTZ, CHECK constraints, and partial indexes all
 * work. The only thing it does NOT support is the TimescaleDB extension,
 * so the `audit_log` hypertable conversion in `001_schema.sql` is
 * effectively a no-op against PGlite (the table is still usable as a
 * regular Postgres table).
 *
 * Rationale for PGlite over `better-sqlite3`:
 *   The CortexOS schema is PG-flavored (JSONB, INET, arrays, CHECK
 *   constraints, partial indexes). A SQLite Drizzle schema would need a
 *   parallel set of column definitions and would not exercise the real
 *   migrations. PGlite runs the actual `migrations/*.sql` files and the
 *   actual Drizzle schema, so unit tests are faithful to production.
 *
 * For real-Docker-Postgres integration tests, use the `getDb()` from
 * `client.ts` against a `pg-mem` or `testcontainers` Postgres.
 */

import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "./schema";
import { runSqlMigrations, type Executor } from "./migrate";

/**
 * Create a fresh PGlite + Drizzle pair.
 *
 * Pass `dataDir` to persist between test cases (rarely needed); default
 * keeps the DB entirely in memory.
 */
export function createPgliteDb(options: { dataDir?: string } = {}): PgliteDatabase<typeof schema> {
  const client = new PGlite(options.dataDir);
  return drizzle(client, { schema, logger: false });
}

export type PgliteDbClient = PgliteDatabase<typeof schema>;

/**
 * Build an `Executor` adapter for a PGlite client.
 */
function pgliteExecutor(client: PGlite): Executor {
  return {
    exec: async (sqlText) => {
      await client.exec(sqlText);
    },
    query: async <T = Record<string, unknown>>(sqlText: string, params?: unknown[]) => {
      const res = params ? await client.query<T>(sqlText, params) : await client.query<T>(sqlText);
      return res.rows;
    },
  };
}

/**
 * Convenience: build a fresh in-memory PGlite, apply the SQL migrations
 * from `migrations/*.sql` in lexical order, and return the Drizzle
 * client + the PGlite instance + the list of migrations that ran.
 *
 * PGlite does NOT ship the TimescaleDB extension, so the migration
 * runner is told to ignore extension-related errors (e.g. the
 * `create_hypertable('audit_log', ...)` call in 001_schema.sql).
 * The audit_log table is still created as a normal Postgres table;
 * only the hypertable conversion is skipped.
 *
 * Test pattern:
 *   const { db, client, ran } = await createMigratedPgliteDb("migrations");
 *   // run queries against `db`
 *   // close with `await client.close()`
 */
export async function createMigratedPgliteDb(migrationsDir: string): Promise<{
  db: PgliteDbClient;
  client: PGlite;
  ran: string[];
}> {
  const client = new PGlite();
  const db = drizzle(client, { schema, logger: false });
  const ran = await runSqlMigrations({
    dir: migrationsDir,
    executor: pgliteExecutor(client),
    ignoreUnsupportedExtensions: true,
    ignoredExtensionPatterns: ["timescaledb"],
  });
  return { db, client, ran };
}

export { pgliteExecutor };
