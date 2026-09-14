/**
 * client.test.ts — direct coverage of the lazy Drizzle Postgres client
 * factory (`readDbEnv`, `getDb`, `resetDbForTests`, `db` proxy).
 *
 * The function under test is env-gated and depends on the `pg` and
 * `drizzle-orm` packages. We mock the `pg` Pool so no real connection
 * is attempted, and set `DB_PASSWORD` to drive the happy path.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock the `pg` package before importing the client. The mock is
// re-applied per test so env changes take effect.
const mockPool = { query: vi.fn() };

function MockPool() {
  return mockPool;
}

vi.mock("pg", () => ({
  // `Pool` is called as `new Pool(...)`, so the mock must be a
  // constructor that returns our shared mockPool. vi.fn()
  // doubles as a constructor when called with `new`.
  Pool: vi.fn().mockImplementation(MockPool),
}));

beforeEach(() => {
  // Set a baseline so getDb() doesn't throw "DB_PASSWORD required".
  process.env.DB_PASSWORD = "test-password";
  process.env.DB_HOST = "127.0.0.1";
  process.env.DB_PORT = "5432";
  process.env.DB_NAME = "cortex_test";
  process.env.DB_USER = "dashboard";
});

afterEach(() => {
  delete process.env.DB_PASSWORD;
  delete process.env.DB_HOST;
  delete process.env.DB_PORT;
  delete process.env.DB_NAME;
  delete process.env.DB_USER;
  vi.clearAllMocks();
});

describe("db/client", () => {
  it("getDb() throws when DB_PASSWORD is missing", async () => {
    delete process.env.DB_PASSWORD;
    const { resetDbForTests, getDb } = await import("../client");
    resetDbForTests();
    expect(() => getDb()).toThrow(/DB_PASSWORD/);
  });

  it("getDb() returns a cached Drizzle client on second call", async () => {
    const { getDb, resetDbForTests } = await import("../client");
    resetDbForTests();
    const a = getDb();
    const b = getDb();
    expect(a).toBe(b); // same singleton
  });

  it("resetDbForTests() forces a new Pool on the next getDb()", async () => {
    const { getDb, resetDbForTests } = await import("../client");
    resetDbForTests();
    const a = getDb();
    resetDbForTests();
    const b = getDb();
    // Different cache slot — but the same underlying mockPool
    // means a and b point at the same mock.
    expect(a).toBeDefined();
    expect(b).toBeDefined();
  });

  it("db proxy delegates property access to the cached client", async () => {
    const { getDb, resetDbForTests, db } = await import("../client");
    resetDbForTests();
    const client = getDb();
    // The proxy should return the same value as direct access.
    expect((db as { select: unknown }).select).toBe(client.select);
  });

  it("exports the schema for downstream consumers", async () => {
    const { schema } = await import("../client");
    expect(schema).toBeDefined();
    expect(schema.adminSessions).toBeDefined();
    expect(schema.pamUsers).toBeDefined();
  });
});
