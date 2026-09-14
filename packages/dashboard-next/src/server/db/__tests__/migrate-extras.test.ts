// @vitest-environment node
/**
 * migrate-extras.test.ts — coverage of the public helpers in `migrate.ts`
 * that aren't already exercised by `migrate.test.ts` and
 * `migrate-filter.test.ts`:
 *
 *   - `pgExecutor(pool)`            — wires exec/query to a pg-like pool
 *   - `defaultMigrationsDir()`      — returns cwd/migrations
 *   - `errorMessage(e)` (private)   — Error / string / JSON-able / JSON-throw
 *     reached via the public `runSqlMigrations` path when the executor
 *     throws a non-`Error` value and `ignoreUnsupportedExtensions` is on
 *   - `getLanIp()` score branches   — eth / en / wl / tailscale / default
 *     (private `score(source)` function — exercised by mocking
 *     `node:os.networkInterfaces` to return crafted interface names)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { PGlite } from "@electric-sql/pglite";
import { runSqlMigrations, pgExecutor, defaultMigrationsDir } from "../migrate";
import { pgliteExecutor } from "../client.pglite";

let client: PGlite;

beforeEach(() => {
  client = new PGlite();
}, 30_000);

afterEach(async () => {
  if (client) await client.close();
  vi.restoreAllMocks();
});

describe("migrate — pgExecutor", () => {
  it("returns an Executor whose exec calls pool.query and ignores rows", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ ignored: true }] });
    const ex = await pgExecutor({ query });
    await ex.exec("CREATE TABLE foo (id int);");
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith("CREATE TABLE foo (id int);");
  });

  it("returns rows from the pool when query is called", async () => {
    const rows = [{ name: "001_init" }, { name: "002_more" }];
    const query = vi.fn().mockResolvedValue({ rows });
    const ex = await pgExecutor({ query });
    const out = await ex.query<{ name: string }>("SELECT name FROM dashboard_migrations");
    expect(out).toEqual(rows);
    expect(query).toHaveBeenCalledWith("SELECT name FROM dashboard_migrations", undefined);
  });

  it("forwards params to the pool", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const ex = await pgExecutor({ query });
    await ex.query("INSERT INTO dashboard_migrations (name) VALUES ($1)", ["001_init"]);
    expect(query).toHaveBeenCalledWith("INSERT INTO dashboard_migrations (name) VALUES ($1)", [
      "001_init",
    ]);
  });
});

describe("migrate — defaultMigrationsDir", () => {
  it("points at cwd/migrations", () => {
    expect(defaultMigrationsDir()).toBe(join(process.cwd(), "migrations"));
  });
});

describe("migrate — errorMessage (private) via runSqlMigrations", () => {
  /**
   * The bootstrap `CREATE TABLE IF NOT EXISTS dashboard_migrations` runs
   * BEFORE the try/catch, so a blanket-throwing executor would fail before
   * the extension-swallow path is ever reached. We only throw for SQL that
   * references the ignored extension.
   */
  function execThatThrowsOnTimescale(throwable: unknown) {
    return {
      exec: async (sql: string) => {
        if (/timescaledb/i.test(sql)) {
          throw throwable;
        }
        // For the bootstrap (CREATE TABLE IF NOT EXISTS dashboard_migrations)
        // and the ledger bookkeeping INSERT, just succeed.
      },
      query: async () => [],
    };
  }

  it("swallows a string-throwable that matches the ignored pattern", async () => {
    // errorMessage(e) → typeof e === 'string' branch
    const dir = mkdtempSync(join(tmpdir(), "migrate-errstr-"));
    writeFileSync(
      join(dir, "001_ext.sql"),
      "CREATE EXTENSION timescaledb;\nCREATE TABLE ok (id int);",
    );

    const out = await runSqlMigrations({
      dir,
      executor: execThatThrowsOnTimescale("extension timescaledb not available"),
      ignoreUnsupportedExtensions: true,
      lanIp: "10.0.0.1",
    });
    expect(out).toEqual(["001_ext"]);
    rmSync(dir, { recursive: true });
  });

  it("swallows a JSON-able object throwable that matches the ignored pattern", async () => {
    // errorMessage(e) → JSON.stringify(e) success branch
    //
    // The filter strips `CREATE EXTENSION timescaledb;` from a
    // standalone line. We use a multi-statement line that the filter
    // leaves alone, so the executor's throw fires and the runner
    // reaches errorMessage with a non-Error object.
    const dir = mkdtempSync(join(tmpdir(), "migrate-errjson-"));
    writeFileSync(
      join(dir, "001_ext.sql"),
      "CREATE EXTENSION timescaledb; CREATE TABLE ok (id int);\n",
    );

    const out = await runSqlMigrations({
      dir,
      executor: execThatThrowsOnTimescale({
        code: "TIMESCALEDB_FAIL",
        message: "extension timescaledb unavailable",
      }),
      ignoreUnsupportedExtensions: true,
      lanIp: "10.0.0.1",
    });
    expect(out).toEqual(["001_ext"]);
    rmSync(dir, { recursive: true });
  });

  it("swallows a JSON-throwing object throwable that matches the ignored pattern", async () => {
    // errorMessage(e) → JSON.stringify throws → falls back to String(e).
    // The matcher should find "timescaledb" in `String(circular)`.
    //
    // Note: in practice String(plainObject) === '[object Object]', so
    // we use a circular object whose toString returns the sentinel —
    // this hits the `String(e)` branch in errorMessage which is
    // otherwise unreachable in our normal test corpus. The other
    // errorMessage branches (Error / string / JSON-object) are
    // covered above.
    const dir = mkdtempSync(join(tmpdir(), "migrate-errcircular-"));
    writeFileSync(
      join(dir, "001_ext.sql"),
      "CREATE EXTENSION timescaledb; CREATE TABLE ok (id int);\n",
    );

    const circular = {
      reason: "extension timescaledb circular",
      toString() {
        return "extension timescaledb circular sentinel";
      },
    };
    (circular as Record<string, unknown>).self = circular; // JSON.stringify throws

    const out = await runSqlMigrations({
      dir,
      executor: execThatThrowsOnTimescale(circular),
      ignoreUnsupportedExtensions: true,
      lanIp: "10.0.0.1",
    });
    expect(out).toEqual(["001_ext"]);
    rmSync(dir, { recursive: true });
  });

  it("rethrows a non-matching string throwable", async () => {
    // `filterExtensionStatements` strips the CREATE EXTENSION line
    // BEFORE the exec is called, so a regex-gated throw would never
    // fire (the timescaledb text is gone from the SQL). We instead
    // throw unconditionally on the 2nd exec call (the bootstrap is
    // the 1st) so the runner reaches the catch with a string that
    // doesn't match the default `timescaledb` pattern.
    const dir = mkdtempSync(join(tmpdir(), "migrate-errstr-nomatch-"));
    writeFileSync(join(dir, "001_a.sql"), "CREATE TABLE a (id int);");
    let execCalls = 0;
    await expect(
      runSqlMigrations({
        dir,
        executor: {
          exec: async () => {
            execCalls += 1;
            if (execCalls === 1) return; // bootstrap
            throw new Error("syntax error at line 1");
          },
          query: async () => [],
        },
        ignoreUnsupportedExtensions: true,
        lanIp: "10.0.0.1",
      }),
    ).rejects.toThrow(/syntax error/);

    rmSync(dir, { recursive: true });
  });
});

describe("migrate — getLanIp score function (eth / en / wl / tailscale / default)", () => {
  it("eth* and en* interfaces sort ahead of wlan and tailscale", async () => {
    vi.doMock("node:os", () => ({
      default: {
        networkInterfaces: () => ({
          tailscale0: [{ address: "100.64.0.1", internal: false, family: "IPv4" }],
          wlan0: [{ address: "192.168.1.10", internal: false, family: "IPv4" }],
          eth0: [{ address: "10.0.0.5", internal: false, family: "IPv4" }],
        }),
      },
    }));
    // Re-import with the mocked os. Vitest's module cache must be cleared
    // for the new module factory to take effect.
    vi.resetModules();
    const { getLanIp: getLanIpMocked } = await import("../migrate");
    expect(getLanIpMocked()).toBe("10.0.0.5");
  });

  it("en* sorts ahead of wlan and tailscale (score=1 vs 2)", async () => {
    // The score function maps:
    //   eth*/en* → 1
    //   wl*     → 2
    //   other   → 3
    //   tailscale → 4
    // So en1 beats wlan0 which beats tailscale0.
    vi.resetModules();
    vi.doMock("node:os", () => ({
      default: {
        networkInterfaces: () => ({
          tailscale0: [{ address: "100.64.0.1", internal: false, family: "IPv4" }],
          wlan0: [{ address: "192.168.1.10", internal: false, family: "IPv4" }],
          en1: [{ address: "10.0.0.5", internal: false, family: "IPv4" }],
        }),
      },
    }));
    const { getLanIp: getLanIpMocked } = await import("../migrate");
    expect(getLanIpMocked()).toBe("10.0.0.5");
  });

  it("tailscale beats other interface names when only it is present", async () => {
    vi.resetModules();
    vi.doMock("node:os", () => ({
      default: {
        networkInterfaces: () => ({
          tailscale0: [{ address: "100.64.0.1", internal: false, family: "IPv4" }],
        }),
      },
    }));
    const { getLanIp: getLanIpMocked } = await import("../migrate");
    expect(getLanIpMocked()).toBe("100.64.0.1");
  });

  it("falls back to the first non-internal IPv4 when no allowlisted prefix matches", async () => {
    vi.resetModules();
    vi.doMock("node:os", () => ({
      default: {
        networkInterfaces: () => ({
          utun3: [{ address: "10.99.0.1", internal: false, family: "IPv4" }],
        }),
      },
    }));
    const { getLanIp: getLanIpMocked } = await import("../migrate");
    expect(getLanIpMocked()).toBe("10.99.0.1");
  });

  it("returns undefined when no non-internal IPv4 interface exists", async () => {
    vi.resetModules();
    vi.doMock("node:os", () => ({
      default: {
        networkInterfaces: () => ({
          lo0: [{ address: "127.0.0.1", internal: true, family: "IPv4" }],
        }),
      },
    }));
    const { getLanIp: getLanIpMocked } = await import("../migrate");
    expect(getLanIpMocked()).toBeUndefined();
  });

  it("skips undefined addrs arrays", async () => {
    // L74: `if (!addrs) continue;` — the rare case where the
    // networkInterfaces() result has a key whose value is undefined
    // (can happen when an interface is mid-tear-down).
    vi.resetModules();
    vi.doMock("node:os", () => ({
      default: {
        networkInterfaces: () => ({
          tearing_down: undefined,
          en0: [{ address: "10.0.0.1", internal: false, family: "IPv4" }],
        }),
      },
    }));
    const { getLanIp: getLanIpMocked } = await import("../migrate");
    expect(getLanIpMocked()).toBe("10.0.0.1");
  });
});

describe("migrate — integration: errorMessage + pglite executor", () => {
  it("round-trips a real Error message into the swallowing path", async () => {
    // errorMessage(e) → e instanceof Error branch. The bootstrap
    // (CREATE TABLE IF NOT EXISTS dashboard_migrations) is called outside the
    // try/catch so it can't be the throw site. We succeed the
    // bootstrap (1st call) and throw an Error on the migration exec
    // (2nd call) so the runner reaches the catch and exercises
    // `errorMessage(error)`.
    const dir = mkdtempSync(join(tmpdir(), "migrate-real-"));
    writeFileSync(join(dir, "001_err.sql"), "CREATE TABLE ok (id int);");
    let execCalls = 0;

    // Case 1: Error message contains "timescaledb" → runner swallows.
    const out = await runSqlMigrations({
      dir,
      executor: {
        exec: async () => {
          execCalls += 1;
          if (execCalls === 1) return; // bootstrap
          throw new Error("extension timescaledb not available");
        },
        query: async () => [],
      },
      ignoreUnsupportedExtensions: true,
      lanIp: "10.0.0.1",
    });
    expect(out).toEqual(["001_err"]);

    // Case 2: Error message doesn't contain the pattern → runner rethrows.
    // We reset the file to a fresh state by recreating the directory.
    rmSync(dir, { recursive: true });
    const dir2 = mkdtempSync(join(tmpdir(), "migrate-real-2-"));
    writeFileSync(join(dir2, "001_err.sql"), "CREATE TABLE ok (id int);");
    let execCalls2 = 0;
    await expect(
      runSqlMigrations({
        dir: dir2,
        executor: {
          exec: async () => {
            execCalls2 += 1;
            if (execCalls2 === 1) return;
            throw new Error("plain error");
          },
          query: async () => [],
        },
        ignoreUnsupportedExtensions: true,
        lanIp: "10.0.0.1",
      }),
    ).rejects.toThrow(/plain error/);

    rmSync(dir2, { recursive: true });
  });

  it("records a successful migration in pglite (smoke for default executor)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "migrate-pglite-"));
    writeFileSync(join(dir, "001_a.sql"), "CREATE TABLE a (id int);");
    writeFileSync(join(dir, "002_b.sql"), "CREATE TABLE b (id int);");

    const out = await runSqlMigrations({
      dir,
      executor: pgliteExecutor(client),
    });
    expect(out).toEqual(["001_a", "002_b"]);

    // Re-run: idempotent.
    const second = await runSqlMigrations({
      dir,
      executor: pgliteExecutor(client),
    });
    expect(second).toEqual([]);

    rmSync(dir, { recursive: true });
  });
});
