/**
 * Programmatic SQL migration runner for the CortexOS dashboard.
 *
 * Reads `migrations/*.sql` in lexical order, applies any that are not
 * already recorded in dashboard-next's OWN namespaced ledger table
 * `dashboard_migrations`. This is the sole live runner
 * (`src/server/db/migrate.ts`); the legacy `scripts/migrate.js` is retired.
 *   - File name must match `^[a-zA-Z0-9_-]+\.sql$`
 *   - `<VPS_LAN_IP>` placeholder is replaced with the host's first
 *     non-internal IPv4 address (sorted: eth/en > wlan/wlp > tailscale)
 *   - Each migration is applied as a single statement (or wrapped in
 *     the transaction the SQL body declares explicitly)
 *   - Re-running is a no-op for already-applied migrations
 *
 * Ledger namespacing & lineage:
 *   The live `cortex_dashboard` DB carries a SHARED legacy `migrations`
 *   table holding ~80 rows from 3+ historical lineages (root / SvelteKit /
 *   dashboard-next). Bare prefixes (002–027) collide across lineages, so
 *   the bare-filename ledger is ambiguous. dashboard-next therefore keeps
 *   its own `dashboard_migrations` table keyed by name + a content
 *   checksum. On first run the runner RECONCILES: it backfills
 *   `dashboard_migrations` from the legacy `migrations` table for ONLY the
 *   names that correspond to files in THIS dir, so a DB where all 15 files
 *   are already applied transitions without re-running anything.
 *
 * Checksum & drift:
 *   Each ledger row stores sha256(RAW file content) — computed BEFORE the
 *   `<VPS_LAN_IP>` substitution, so it is stable across hosts. If an
 *   already-recorded migration's current file checksum differs from the
 *   stored one, the runner emits a loud warning (content drift = an applied
 *   migration was edited) but does NOT re-apply or auto-mutate.
 *
 * The runner is DB-agnostic: it accepts an `Executor` that can both
 *   - `exec(sql)`: run a multi-statement DDL string and discard results
 *   - `query(sql, params)`: parameterised SELECT/INSERT, returning rows
 *
 * Production callers pass pg-backed implementations; pglite-backed tests
 * pass PGlite adapters.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { runSequentially } from "@/lib/sequential";

const SAFE_FILENAME_RE = /^[a-zA-Z0-9_-]+\.sql$/;

export interface Executor {
  /** Run a multi-statement DDL string and ignore any rows. */
  exec: (sql: string) => Promise<void>;
  /** Parameterised SELECT/INSERT/UPDATE returning rows (or empty). */
  query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
}

export interface RunMigrationsOptions {
  /** Where the SQL files live. */
  dir: string;
  executor: Executor;
  /** Override the LAN IP detection (defaults to `getLanIp()`). */
  lanIp?: string;
  /**
   * Tolerate failures that only apply to the production Postgres
   * extension set (TimescaleDB's `create_hypertable`, etc.). The
   * canonical migrations reference these extensions; against a
   * test driver that doesn't ship them (e.g. pglite) the relevant
   * statements fail, but the rest of the migration is valid.
   *
   * When `true`, the runner swallows the extension-related errors
   * and continues. Use only in tests; production callers leave it
   * `false` (the default).
   */
  ignoreUnsupportedExtensions?: boolean;
  /**
   * Substrings of error messages that, when matched, should be
   * treated as "extension not available" and ignored. Default:
   * `["timescaledb"]`. Used together with `ignoreUnsupportedExtensions`.
   */
  ignoredExtensionPatterns?: string[];
}

/**
 * Find the most likely LAN IP for `<VPS_LAN_IP>` replacement. Mirrors
 * `src/lib/db/migrate.ts:8-31` (the existing pg-based runner) and
 * `scripts/migrate.js:11-30` so the two runners stay in sync.
 */
export function getLanIp(): string | undefined {
  const ifaces = os.networkInterfaces();
  const candidates: { ip: string; source: string }[] = [];

  Object.entries(ifaces).forEach(([name, addrs]) => {
    if (!addrs) return;
    addrs.forEach((addr) => {
      if (addr.internal) return;
      if (addr.family !== "IPv4") return;
      candidates.push({ ip: addr.address, source: name });
    });
  });

  const score = (source: string): number => {
    const s = source.toLowerCase();
    if (s.startsWith("eth") || s.startsWith("en")) return 1;
    if (s.startsWith("wl") || s.startsWith("wl")) return 2;
    if (s.startsWith("tailscale")) return 4;
    return 3;
  };

  candidates.sort((a, b) => score(a.source) - score(b.source));
  return candidates[0]?.ip;
}

export function replaceVpsLanIp(sql: string, ip: string): string {
  return sql.replace(/<VPS_LAN_IP>/g, ip);
}

interface MigrationRow {
  name: string;
}

interface DashboardMigrationRow {
  name: string;
  checksum: string;
}

/** Ledger table name for dashboard-next's namespaced migration history. */
const LEDGER_TABLE = "dashboard_migrations";

/**
 * sha256 hex digest of the RAW migration file content. Computed BEFORE
 * the `<VPS_LAN_IP>` substitution so the checksum is identical across
 * hosts (the placeholder is part of the committed file, the resolved IP
 * is host-specific and would make the digest unstable).
 */
function migrationChecksum(rawSql: string): string {
  return createHash("sha256").update(rawSql, "utf-8").digest("hex");
}

/**
 * Best-effort check whether a relation exists, used to guard the
 * legacy-table read during reconciliation. Returns false if the
 * `to_regclass` probe itself fails (driver without the function, etc.).
 */
async function relationExists(executor: Executor, table: string): Promise<boolean> {
  try {
    const rows = await executor.query<{ reg: string | null }>("SELECT to_regclass($1) AS reg", [
      table,
    ]);
    return rows[0]?.reg != null;
  } catch {
    return false;
  }
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

function isIgnoredExtensionError(e: unknown, patterns?: string[]): boolean {
  const msg = errorMessage(e).toLowerCase();
  const all = (patterns ?? ["timescaledb"]).map((p) => p.toLowerCase());
  return all.some((p) => msg.includes(p));
}

/**
 * Drop statements that reference ignored extensions. Used to make
 * TimescaleDB-tinged migrations runnable against PGlite (which doesn't
 * ship the extension). Conservative: matches lines that contain
 * `CREATE EXTENSION ... <pattern>` or `create_hypertable(` and
 * replaces them with empty strings. Comment lines are also removed
 * to keep the resulting SQL clean.
 */
function filterExtensionStatements(sql: string, patterns?: string[]): string {
  const all = (patterns ?? ["timescaledb"]).map((p) => p.toLowerCase());
  let out = sql;
  all.forEach((p) => {
    const pEsc = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Remove `CREATE EXTENSION [IF NOT EXISTS] <name>` lines.
    out = out.replace(
      new RegExp(
        `^\\s*CREATE\\s+EXTENSION(\\s+IF\\s+NOT\\s+EXISTS)?\\s+["']?${pEsc}["']?\\s*;?\\s*$`,
        "gim",
      ),
      "",
    );
    // Remove `SELECT create_hypertable(...)` statements. Match any
    // line containing `create_hypertable(`, regardless of where
    // the `;` lands (single-line statements only — multi-line
    // `create_hypertable` is not used in the current migrations).
    out = out.replace(/^[^\n]*create_hypertable\s*\([^\n]*;?\s*$/gim, "");
  });
  // Collapse runs of blank lines left behind.
  out = out.replace(/\n{3,}/g, "\n\n");
  return out;
}

/**
 * Run all un-applied migrations in `dir` against the supplied `executor`.
 *
 * Returns the list of migration names that were actually applied (in
 * the order they were applied). Idempotent: re-running returns [].
 */
export async function runSqlMigrations(opts: RunMigrationsOptions): Promise<string[]> {
  // Bootstrap dashboard-next's OWN namespaced ledger table if it doesn't
  // exist yet. Safe to re-run (IF NOT EXISTS). Keyed by name + a content
  // checksum so drift in an applied migration is detectable.
  await opts.executor.exec(`
		CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
			id SERIAL PRIMARY KEY,
			name VARCHAR(255) UNIQUE NOT NULL,
			checksum CHAR(64) NOT NULL,
			applied_at TIMESTAMP DEFAULT NOW()
		)
	`);

  // Enumerate the migration files in this dir up-front so both
  // reconciliation and the apply loop work off the same list.
  const files = readdirSync(opts.dir)
    .filter((f) => f.endsWith(".sql") && SAFE_FILENAME_RE.test(f))
    .sort();
  const entries = files.map((file) => {
    const filePath = join(opts.dir, file);
    const rawSql = readFileSync(filePath, "utf-8");
    return {
      file,
      filePath,
      name: file.replace(/\.sql$/, ""),
      rawSql,
      checksum: migrationChecksum(rawSql),
    };
  });

  // RECONCILIATION (one-time, automatic, idempotent). If the ledger is
  // freshly created/empty AND a legacy shared `migrations` table exists
  // with rows, backfill `dashboard_migrations` for ONLY the names that
  // correspond to files in THIS dir. This lets a live prod DB (where all
  // these migrations were already applied under the shared ledger)
  // transition WITHOUT re-running any migration. A truly fresh DB (no
  // legacy rows) backfills nothing and applies everything fresh.
  const ledgerCount = await opts.executor.query<{ n: string | number }>(
    `SELECT COUNT(*) AS n FROM ${LEDGER_TABLE}`,
  );
  const ledgerIsEmpty = Number(ledgerCount[0]?.n ?? 0) === 0;
  if (ledgerIsEmpty && (await relationExists(opts.executor, "migrations"))) {
    const legacy = await opts.executor.query<MigrationRow>("SELECT name FROM migrations");
    const legacyNames = new Set(legacy.map((m) => m.name));
    const toBackfill = entries.filter((e) => legacyNames.has(e.name));
    await runSequentially(toBackfill, async (e) => {
      await opts.executor.query(
        `INSERT INTO ${LEDGER_TABLE} (name, checksum) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING`,
        [e.name, e.checksum],
      );
    });
  }

  // Build the recorded-set + stored checksums from the namespaced ledger.
  const applied = await opts.executor.query<DashboardMigrationRow>(
    `SELECT name, checksum FROM ${LEDGER_TABLE} ORDER BY name`,
  );
  const appliedChecksums = new Map(applied.map((m) => [m.name, m.checksum]));

  const run: string[] = [];

  // CHECKSUM DRIFT DETECTION: for any file whose name is already recorded,
  // compare stored vs current checksum. On mismatch, warn loudly (someone
  // edited an applied migration) but do NOT re-apply or auto-mutate.
  entries.forEach((e) => {
    const stored = appliedChecksums.get(e.name);
    if (stored !== undefined && stored !== e.checksum) {
      console.warn(
        `[migrate] checksum drift for already-applied migration "${e.name}": ` +
          `stored=${stored} current=${e.checksum}. The file content changed ` +
          `after it was applied. Skipping re-apply (not auto-mutating); ` +
          `reconcile manually if this is intentional.`,
      );
    }
  });

  const pending = entries.filter((e) => !appliedChecksums.has(e.name));

  await runSequentially(pending, async ({ filePath, name, rawSql, checksum }) => {
    // Defence-in-depth: ensure the resolved path is still inside `dir`.
    if (!filePath.startsWith(opts.dir)) return;
    const sqlText = rawSql;
    const ip = opts.lanIp ?? getLanIp();
    let finalSql = ip ? replaceVpsLanIp(sqlText, ip) : sqlText;

    // When running against a driver that doesn't ship the prod
    // extensions (e.g. PGlite without TimescaleDB), pre-filter the
    // SQL to drop the extension-only statements. Without this,
    // PGlite's `exec` rolls back the entire batch when the first
    // `CREATE EXTENSION` fails — meaning no tables get created.
    //
    // The pre-filter is conservative: it removes lines that match
    // the ignored patterns (CREATE EXTENSION, create_hypertable
    // for TimescaleDB). It does NOT touch the rest of the schema.
    if (opts.ignoreUnsupportedExtensions) {
      finalSql = filterExtensionStatements(finalSql, opts.ignoredExtensionPatterns);
    }

    // Apply the migration. The `executor.exec` is allowed to wrap
    // in a transaction (pg's Pool.query is a single implicit
    // transaction per call). SQL bodies that need their own
    // transaction (`BEGIN; ... COMMIT;`) declare it explicitly.
    try {
      await opts.executor.exec(finalSql);
    } catch (e) {
      if (
        opts.ignoreUnsupportedExtensions &&
        isIgnoredExtensionError(e, opts.ignoredExtensionPatterns)
      ) {
        // The migration file references an extension that the
        // test driver doesn't ship (e.g. TimescaleDB on PGlite).
        // The migration runner records the file as "applied" so
        // subsequent runs treat the rest of the schema as
        // already established. This matches what a real
        // prod-without-TimescaleDB would experience.
      } else {
        throw e;
      }
    }

    // Record the applied migration in the namespaced ledger, with its
    // content checksum. Parameterised; safe regardless of filename
    // contents. The runner records names itself, so migration files do
    // NOT need a trailing `INSERT INTO migrations ...` footer.
    await opts.executor.query(
      `INSERT INTO ${LEDGER_TABLE} (name, checksum) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING`,
      [name, checksum],
    );
    run.push(name);
  });

  return run;
}

/**
 * Default `dir`: the dashboard package's `migrations/` directory,
 * resolved relative to the process working directory. Mirrors
 * `lib/db/migrate.ts:6` (MIGRATIONS_DIR = cwd/migrations).
 */
export function defaultMigrationsDir(): string {
  return join(process.cwd(), "migrations");
}

/**
 * Build an `Executor` from the production pg Pool. Used by the runtime
 * entrypoint to wire `migrate.ts` to the same `pg` instance the rest
 * of the data layer uses.
 */
export async function pgExecutor(pool: {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
}): Promise<Executor> {
  return {
    exec: async (sql) => {
      await pool.query(sql);
    },
    query: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
      const res = await pool.query(sql, params);
      return res.rows as T[];
    },
  };
}
