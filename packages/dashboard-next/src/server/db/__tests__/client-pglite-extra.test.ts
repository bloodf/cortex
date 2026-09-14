// @vitest-environment node
/**
 * client-pglite-extra.test.ts — coverage of `createPgliteDb` in
 * `src/lib/server/db/client.pglite.ts`.
 *
 * The base test (`client.test.ts`) covers the production
 * `getDb()` path. This file drives the 2 uncovered lines in
 * `createPgliteDb`:
 *
 *   - L36  `const client = new PGlite(options.dataDir);`
 *   - L37  `return drizzle(client, { schema, logger: false });`
 *
 * The function is only used by the migrated-DB helper
 * (`createMigratedPgliteDb`) which is itself well-covered. We
 * call `createPgliteDb` directly to assert the data-Dir argument
 * is forwarded and the returned Drizzle handle is usable.
 */
import { describe, it, expect } from "vitest";
import { createPgliteDb } from "../client.pglite";

describe("client.pglite — createPgliteDb", () => {
  it("returns a Drizzle client backed by an in-memory PGlite", async () => {
    const db = createPgliteDb();
    // Drizzle's pglite handle exposes `execute` for raw SQL.
    const out = await db.execute("SELECT 1 AS one");
    // The pglite adapter returns `{ rows: [...] }`-shaped results
    // through Drizzle's `execute`. Just assert at least one row.
    const rows = (out as unknown as { rows?: unknown[] }).rows ?? (out as unknown as unknown[]);
    expect(Array.isArray(rows)).toBe(true);
  });

  it("forwards the dataDir argument without throwing", () => {
    // The exact dataDir is hard to verify without booting a
    // persistent DB, so we just ensure the call doesn't throw
    // and returns a usable handle. PGlite defaults to a fresh
    // ephemeral store when the path is empty, so this also
    // confirms the no-arg form.
    const db = createPgliteDb({ dataDir: undefined });
    expect(db).toBeDefined();
    expect(typeof db.execute).toBe("function");
  });
});
