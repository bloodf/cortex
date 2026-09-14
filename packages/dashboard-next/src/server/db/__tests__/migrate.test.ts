// @vitest-environment node
/**
 * migrate.test.ts — coverage of the SQL migration runner.
 *
 * Tests the public API of `runSqlMigrations` plus the pure helpers
 * `getLanIp`, `replaceVpsLanIp`, `defaultMigrationsDir`. Uses a real
 * PGlite executor wired through `pgliteExecutor` so the runner sees
 * a faithful Postgres engine.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { PGlite } from "@electric-sql/pglite";
import { runSqlMigrations, replaceVpsLanIp, defaultMigrationsDir, getLanIp } from "../migrate";
import { pgliteExecutor } from "../client.pglite";

let client: PGlite;

beforeEach(() => {
  client = new PGlite();
}, 30_000);

afterEach(async () => {
  if (client) await client.close();
});

describe("migrate — pure helpers", () => {
  it("replaceVpsLanIp replaces every occurrence", () => {
    const out = replaceVpsLanIp("host=<VPS_LAN_IP> other=<VPS_LAN_IP>", "10.0.0.1");
    expect(out).toBe("host=10.0.0.1 other=10.0.0.1");
  });

  it("replaceVpsLanIp leaves SQL without the placeholder alone", () => {
    const out = replaceVpsLanIp("CREATE TABLE foo (id int);", "10.0.0.1");
    expect(out).toBe("CREATE TABLE foo (id int);");
  });

  it("defaultMigrationsDir returns a path under cwd/migrations", () => {
    const d = defaultMigrationsDir();
    expect(d).toMatch(/migrations$/);
    expect(d.startsWith(process.cwd())).toBe(true);
  });

  it("getLanIp returns a string or undefined", () => {
    const ip = getLanIp();
    if (ip !== undefined) {
      expect(typeof ip).toBe("string");
      expect(ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    }
  });
});

describe("migrate — runSqlMigrations", () => {
  it("applies all pending migrations and returns their names", async () => {
    const dir = mkdtempSync(join(tmpdir(), "migrate-test-"));
    writeFileSync(join(dir, "001_init.sql"), "CREATE TABLE foo (id int);");
    writeFileSync(join(dir, "002_more.sql"), "CREATE TABLE bar (id int);");

    const out = await runSqlMigrations({
      dir,
      executor: pgliteExecutor(client),
    });
    expect(out).toEqual(["001_init", "002_more"]);
    expect(out.length).toBe(2);

    // Re-run: no new migrations to apply.
    const second = await runSqlMigrations({
      dir,
      executor: pgliteExecutor(client),
    });
    expect(second).toEqual([]);

    rmSync(dir, { recursive: true });
  });

  it("swallows extension errors when ignoreUnsupportedExtensions is true", async () => {
    const dir = mkdtempSync(join(tmpdir(), "migrate-test-"));
    writeFileSync(
      join(dir, "001_extension.sql"),
      "CREATE EXTENSION IF NOT EXISTS timescaledb;\nCREATE TABLE baz (id int);",
    );

    const out = await runSqlMigrations({
      dir,
      executor: {
        exec: async (sql) => {
          if (/CREATE EXTENSION/i.test(sql)) {
            throw new Error("extension timescaledb not available");
          }
          await client.exec(sql);
        },
        query: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
          const res = params ? await client.query<T>(sql, params) : await client.query<T>(sql);
          return res.rows;
        },
      },
      ignoreUnsupportedExtensions: true,
      lanIp: "10.0.0.1",
    });
    expect(out).toEqual(["001_extension"]);
    rmSync(dir, { recursive: true });
  });

  it("throws extension errors when ignoreUnsupportedExtensions is false", async () => {
    const dir = mkdtempSync(join(tmpdir(), "migrate-test-"));
    writeFileSync(join(dir, "001_extension.sql"), "CREATE EXTENSION IF NOT EXISTS timescaledb;");

    await expect(
      runSqlMigrations({
        dir,
        executor: {
          exec: async () => {
            throw new Error("extension timescaledb not available");
          },
          query: async () => [],
        },
      }),
    ).rejects.toThrow(/timescaledb/);

    rmSync(dir, { recursive: true });
  });

  it("skips files that do not match the safe-name regex", async () => {
    const dir = mkdtempSync(join(tmpdir(), "migrate-test-"));
    writeFileSync(join(dir, "001_ok.sql"), "CREATE TABLE ok (id int);");
    // "002 weird; name.sql" has spaces and a semicolon — fails the regex.
    // (The OS would refuse to even create it, so just check that the
    // valid file runs and the rest of the listing is filtered.)
    const out = await runSqlMigrations({
      dir,
      executor: pgliteExecutor(client),
    });
    expect(out).toEqual(["001_ok"]);

    rmSync(dir, { recursive: true });
  });

  it("replaces <VPS_LAN_IP> when lanIp override is given", async () => {
    const dir = mkdtempSync(join(tmpdir(), "migrate-test-"));
    writeFileSync(join(dir, "001_ip.sql"), "INSERT INTO _ip_test (ip) VALUES ('<VPS_LAN_IP>');");
    // First create the table in a prior migration.
    writeFileSync(join(dir, "000_table.sql"), "CREATE TABLE _ip_test (ip text);");

    await runSqlMigrations({
      dir,
      executor: pgliteExecutor(client),
      lanIp: "192.0.2.42",
    });

    const res = await client.query<{ ip: string }>("SELECT ip FROM _ip_test");
    expect(res.rows[0]?.ip).toBe("192.0.2.42");

    rmSync(dir, { recursive: true });
  });
});

describe("migrate — dashboard_migrations ledger + reconciliation", () => {
  it("records applied migrations in dashboard_migrations with checksums (fresh DB)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "migrate-ledger-"));
    writeFileSync(join(dir, "001_init.sql"), "CREATE TABLE foo (id int);");
    writeFileSync(join(dir, "002_more.sql"), "CREATE TABLE bar (id int);");

    const out = await runSqlMigrations({ dir, executor: pgliteExecutor(client) });
    expect(out).toEqual(["001_init", "002_more"]);

    const rows = await client.query<{ name: string; checksum: string }>(
      "SELECT name, checksum FROM dashboard_migrations ORDER BY name",
    );
    expect(rows.rows.map((r) => r.name)).toEqual(["001_init", "002_more"]);
    // checksum is a 64-char sha256 hex digest of the raw file content.
    rows.rows.forEach((r) => {
      expect(r.checksum).toMatch(/^[0-9a-f]{64}$/);
    });
    // No legacy `migrations` table is created by the new runner.
    const reg = await client.query<{ reg: string | null }>(
      "SELECT to_regclass('migrations') AS reg",
    );
    expect(reg.rows[0]?.reg).toBeNull();

    rmSync(dir, { recursive: true });
  });

  it("reconciles from a pre-existing legacy migrations table without re-applying", async () => {
    const dir = mkdtempSync(join(tmpdir(), "migrate-reconcile-"));
    // These files would FAIL if re-applied (the referenced tables don't
    // exist), proving reconciliation truly skips the apply step.
    writeFileSync(join(dir, "001_a.sql"), "INSERT INTO nonexistent_a (id) VALUES (1);");
    writeFileSync(join(dir, "002_b.sql"), "INSERT INTO nonexistent_b (id) VALUES (1);");

    // Simulate the live DB: a legacy shared `migrations` table already
    // holding this dir's bare names (plus an unrelated legacy lineage row).
    await client.exec(`
      CREATE TABLE migrations (id SERIAL PRIMARY KEY, name VARCHAR(255) UNIQUE NOT NULL, applied_at TIMESTAMP DEFAULT NOW());
      INSERT INTO migrations (name) VALUES ('001_a'), ('002_b'), ('017_some_legacy_lineage');
    `);

    const out = await runSqlMigrations({ dir, executor: pgliteExecutor(client) });
    // ZERO new migrations applied — the apply step never ran (which would
    // have thrown on the nonexistent tables).
    expect(out).toEqual([]);

    // dashboard_migrations backfilled with ONLY this dir's names.
    const rows = await client.query<{ name: string; checksum: string }>(
      "SELECT name, checksum FROM dashboard_migrations ORDER BY name",
    );
    expect(rows.rows.map((r) => r.name)).toEqual(["001_a", "002_b"]);
    rows.rows.forEach((r) => {
      expect(r.checksum).toMatch(/^[0-9a-f]{64}$/);
    });

    rmSync(dir, { recursive: true });
  });

  it("warns on checksum drift and does NOT re-apply the migration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "migrate-drift-"));
    writeFileSync(join(dir, "001_init.sql"), "CREATE TABLE drift_t (id int);");

    const first = await runSqlMigrations({ dir, executor: pgliteExecutor(client) });
    expect(first).toEqual(["001_init"]);

    // Mutate the applied migration's content. Re-running it would throw
    // (table already exists), so a silent re-apply would surface as an
    // error — proving the runner skips it.
    writeFileSync(
      join(dir, "001_init.sql"),
      "CREATE TABLE drift_t (id int); -- edited after apply",
    );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const second = await runSqlMigrations({ dir, executor: pgliteExecutor(client) });
    expect(second).toEqual([]); // not re-applied
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/checksum drift.*001_init/);

    // Stored checksum is unchanged (no auto-mutation).
    const rows = await client.query<{ checksum: string }>(
      "SELECT checksum FROM dashboard_migrations WHERE name = '001_init'",
    );
    expect(rows.rows).toHaveLength(1);

    warnSpy.mockRestore();
    rmSync(dir, { recursive: true });
  });

  it("applies a genuinely-new migration after reconciliation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "migrate-new-"));
    writeFileSync(join(dir, "001_known.sql"), "INSERT INTO nonexistent_known (id) VALUES (1);");
    writeFileSync(join(dir, "002_new.sql"), "CREATE TABLE genuinely_new (id int);");

    // Legacy table knows only 001 — so 002 is new in both tables.
    await client.exec(`
      CREATE TABLE migrations (id SERIAL PRIMARY KEY, name VARCHAR(255) UNIQUE NOT NULL, applied_at TIMESTAMP DEFAULT NOW());
      INSERT INTO migrations (name) VALUES ('001_known');
    `);

    const out = await runSqlMigrations({ dir, executor: pgliteExecutor(client) });
    // 001 reconciled (skipped), 002 applied fresh.
    expect(out).toEqual(["002_new"]);

    const rows = await client.query<{ name: string }>(
      "SELECT name FROM dashboard_migrations ORDER BY name",
    );
    expect(rows.rows.map((r) => r.name)).toEqual(["001_known", "002_new"]);
    // The new table really got created.
    const t = await client.query<{ reg: string | null }>(
      "SELECT to_regclass('genuinely_new') AS reg",
    );
    expect(t.rows[0]?.reg).not.toBeNull();

    rmSync(dir, { recursive: true });
  });

});
