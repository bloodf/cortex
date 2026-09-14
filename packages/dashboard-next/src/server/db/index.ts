/**
 * Public surface of the dashboard data layer.
 *
 * Re-exports the Drizzle client, schema types, migration runner, and
 * repository functions. SvelteKit server endpoints should import from
 * `$lib/server/db` (the package root), not from individual submodules.
 *
 * The Next.js data layer in `src/lib/db/` is a separate, parallel
 * surface. The two will coexist during the migration window. The
 * SvelteKit layer is the new home; the Next.js layer is being
 * ported in M2+.
 */

export * from "./schema";
export { getDb, db, type DbClient } from "./client";
export { createPgliteDb, createMigratedPgliteDb, type PgliteDbClient } from "./client.pglite";
export {
  runSqlMigrations,
  getLanIp,
  replaceVpsLanIp,
  defaultMigrationsDir,
  pgExecutor,
  type Executor,
  type RunMigrationsOptions,
} from "./migrate";

export * as users from "./repos/users";
export * as services from "./repos/services";
export * as alerts from "./repos/alerts";
export * as audit from "./repos/audit";
export * as dashboardCommandAudit from "./repos/dashboard_command_audit";
