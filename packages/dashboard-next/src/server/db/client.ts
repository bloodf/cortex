/**
 * Drizzle ORM client for the CortexOS dashboard.
 *
 * Production: `node-postgres` Pool (real Postgres + TimescaleDB).
 * Tests: pglite (in-memory Postgres in WASM) — see `client.pglite.ts`.
 *
 * The Drizzle instance is cached as a module-level singleton. Connection
 * settings are taken from the same `DB_*` env vars used by the existing
 * `src/lib/db/client.ts` (pg) so the new and old layers are interchangeable.
 *
 * Usage:
 *   import { db } from '$lib/server/db/client';
 *   const rows = await db.select().from(services);
 *
 * `DbClient` is typed loosely (`PgDatabase<any, ...>`) so the same
 * functions work with both `node-postgres` and `pglite` clients. The
 * Drizzle query API is identical at the call sites I use; the only
 * thing that differs is the HKT for query results, which my repos
 * don't depend on. If you need the HKT-typed client, use
 * `NodePgDatabase<typeof schema>` directly (exported below).
 */

import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema";

let cachedDb: NodePgDatabase<typeof schema> | null = null;

/**
 * Read required env vars. Throws fast (fail at boot) if `DB_PASSWORD` is
 * missing — same posture as the existing `lib/db/client.ts`.
 */
function readDbEnv() {
  if (!process.env.DB_PASSWORD) {
    throw new Error("DB_PASSWORD environment variable is required (drizzle client)");
  }
  return {
    host: process.env.DB_HOST || "127.0.0.1",
    port: parseInt(process.env.DB_PORT || "5432", 10),
    database: process.env.DB_NAME || "cortex_dashboard",
    user: process.env.DB_USER || "dashboard",
    password: process.env.DB_PASSWORD,
    // Match the existing pg pool tuning (lib/db/client.ts:30-34) so the
    // two layers have the same connection semantics.
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  } as const;
}

/**
 * Get (or lazily create) the Drizzle client bound to the production
 * `node-postgres` Pool. The returned client has the full schema typed in
 * (relational queries mode: `db.query.services.findMany()`).
 */
export function getDb(): NodePgDatabase<typeof schema> {
  if (!cachedDb) {
    const pool = new Pool(readDbEnv());
    cachedDb = drizzle(pool, { schema, logger: false });
  }
  return cachedDb;
}

/**
 * Convenience export: the singleton Drizzle client.
 *
 * Lazy — does NOT call `getDb()` at import time. This matters because the
 * SvelteKit adapter-node runtime may import this file in contexts where
 * `DB_PASSWORD` is intentionally absent (build steps, type-only imports).
 */
export const db = new Proxy({} as NodePgDatabase<typeof schema>, {
  get(_target, prop, receiver) {
    return Reflect.get(getDb(), prop, receiver);
  },
});

/**
 * For tests: reset the cached client so a new env can take effect.
 * Not exported from the package barrel.
 */
export function resetDbForTests() {
  cachedDb = null;
}

/** For tests: install a specific (e.g. pglite) client as the singleton. */
export function setDbForTests(client: DbClient): void {
  cachedDb = client as unknown as NodePgDatabase<typeof schema>;
}

/**
 * Cross-driver Drizzle client type. The repos accept this so they
 * work with both the production `node-postgres` and the test `pglite`
 * drivers. The HKT is widened to `PgQueryResultHKT` (the abstract
 * supertype) so the result type stays compatible across both.
 */
export type DbClient = PgDatabase<PgQueryResultHKT, typeof schema>;

/** Strict production-typed client (for places that need full HKT info). */
export type NodePgDbClient = NodePgDatabase<typeof schema>;

export { schema };
