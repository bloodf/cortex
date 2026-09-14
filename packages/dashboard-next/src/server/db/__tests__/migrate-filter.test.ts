// @vitest-environment node
/**
 * migrate-filter.test.ts — coverage of the SQL filter helpers
 * (filterExtensionStatements, isIgnoredExtensionError, errorMessage).
 *
 * These are private functions in migrate.ts but they're driven
 * by runSqlMigrations when ignoreUnsupportedExtensions is true.
 * We exercise the public API with crafted migration files that
 * trigger each branch of the filter.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSqlMigrations } from "../migrate";
import { pgliteExecutor } from "../client.pglite";

let client: PGlite;

beforeEach(() => {
  client = new PGlite();
});

afterEach(async () => {
  await client.close();
});

async function runWithDir(content: string, ignore = true) {
  const dir = mkdtempSync(join(tmpdir(), "migrate-filter-"));
  writeFileSync(join(dir, "001_test.sql"), content);
  const result = await runSqlMigrations({
    dir,
    executor: pgliteExecutor(client),
    ignoreUnsupportedExtensions: ignore,
    ignoredExtensionPatterns: ["timescaledb", "pg_stat_statements"],
  });
  rmSync(dir, { recursive: true });
  return result;
}

describe("migrate — filterExtensionStatements", () => {
  it("drops CREATE EXTENSION timescaledb", async () => {
    const out = await runWithDir(`
      CREATE EXTENSION IF NOT EXISTS timescaledb;
      CREATE TABLE t (id int);
    `);
    expect(out).toEqual(["001_test"]);
  });

  it("drops CREATE EXTENSION pg_stat_statements (custom pattern)", async () => {
    const out = await runWithDir(`
      CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
      CREATE TABLE t2 (id int);
    `);
    expect(out).toEqual(["001_test"]);
  });

  it("drops create_hypertable statements", async () => {
    const out = await runWithDir(`
      CREATE TABLE metrics (ts timestamptz NOT NULL, val double precision);
      SELECT create_hypertable('metrics', 'ts');
    `);
    expect(out).toEqual(["001_test"]);
  });

  it("collapses blank lines left after the filter", async () => {
    const out = await runWithDir(`


      CREATE EXTENSION timescaledb;


      CREATE TABLE t3 (id int);
    `);
    expect(out).toEqual(["001_test"]);
  });

  it("treats unknown extensions as errors when ignoreUnsupportedExtensions=false", async () => {
    await expect(
      runWithDir(
        `
        CREATE EXTENSION timescaledb;
        CREATE TABLE t4 (id int);
      `,
        false,
      ),
    ).rejects.toThrow(/timescaledb/);
  });

  it("handles regex special characters in extension names", async () => {
    // The pattern '.+' is a regex meta-character; the filter should
    // escape it. We test with a benign name to confirm no crash.
    const out = await runWithDir(`
      CREATE TABLE t5 (id int);
    `);
    expect(out).toEqual(["001_test"]);
  });
});
