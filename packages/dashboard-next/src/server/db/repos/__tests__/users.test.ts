// @vitest-environment node
/**
 * Users repository tests.
 *
 * Covers: PAM user upsert, session creation, session resolution
 * (with expiry check), session deletion, per-user session deletion,
 * list-active-sessions.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDb, type PgliteDbClient } from "../../test-utils";
import {
  upsertPamUser,
  getPamUserById,
  getPamUserByUsername,
  listPamUsers,
  deletePamUser,
  createAdminSession,
  resolveSessionByToken,
  deleteAdminSession,
  deleteAdminSessionsForUser,
  listActiveAdminSessions,
} from "../users";

let db: PgliteDbClient;
let client: PGlite;

beforeEach(async () => {
  const r = await createTestDb();
  db = r.db;
  client = r.client;
}, 30_000);

afterEach(async () => {
  if (client) await client.close();
});

describe("users repo — PAM users", () => {
  it("upsertPamUser creates a new user", async () => {
    const u = await upsertPamUser(db, { username: "alice" });
    expect(u.username).toBe("alice");
    expect(u.id).toBeGreaterThan(0);
  });

  it("upsertPamUser rejects empty username", async () => {
    await expect(upsertPamUser(db, { username: "   " })).rejects.toThrow(
      "PAM username is required",
    );
  });

  it("upsertPamUser is idempotent on the same username", async () => {
    const a = await upsertPamUser(db, { username: "bob" });
    const b = await upsertPamUser(db, { username: "bob" });
    expect(b.id).toBe(a.id);
  });

  it("getPamUserById returns the row", async () => {
    const u = await upsertPamUser(db, { username: "carol" });
    const got = await getPamUserById(db, u.id);
    expect(got?.username).toBe("carol");
  });

  it("getPamUserById returns null for missing id", async () => {
    const got = await getPamUserById(db, 99_999);
    expect(got).toBeNull();
  });

  it("getPamUserByUsername returns the row", async () => {
    await upsertPamUser(db, { username: "dave" });
    const got = await getPamUserByUsername(db, "dave");
    expect(got?.username).toBe("dave");
  });

  it("listPamUsers returns all users with session counts", async () => {
    const u = await upsertPamUser(db, { username: "eve" });
    await createAdminSession(db, {
      userId: u.id,
      token: "tok-1",
      expiresAt: new Date(Date.now() + 60_000),
      isAdmin: false,
    });
    const rows = await listPamUsers(db);
    const eve = rows.find((r) => r.username === "eve");
    expect(eve?.activeSessions).toBe(1);
  });

  it("deletePamUser returns true on success, false on missing", async () => {
    const u = await upsertPamUser(db, { username: "frank" });
    expect(await deletePamUser(db, u.id)).toBe(true);
    expect(await deletePamUser(db, u.id)).toBe(false);
  });
});

describe("users repo — admin sessions", () => {
  let userId: number;
  beforeEach(async () => {
    const u = await upsertPamUser(db, { username: "tester" });
    userId = u.id;
  });

  it("createAdminSession inserts and returns a session row", async () => {
    const s = await createAdminSession(db, {
      userId,
      token: "tok-create",
      expiresAt: new Date(Date.now() + 60_000),
      isAdmin: true,
    });
    expect(s.token).toBe("tok-create");
    expect(s.isAdmin).toBe(true);
  });

  it("resolveSessionByToken returns the session + username", async () => {
    await createAdminSession(db, {
      userId,
      token: "tok-resolve",
      expiresAt: new Date(Date.now() + 60_000),
      isAdmin: false,
    });
    const got = await resolveSessionByToken(db, "tok-resolve");
    expect(got?.username).toBe("tester");
  });

  it("resolveSessionByToken returns null for an expired session", async () => {
    await createAdminSession(db, {
      userId,
      token: "tok-expired",
      expiresAt: new Date(Date.now() - 60_000),
      isAdmin: false,
    });
    const got = await resolveSessionByToken(db, "tok-expired");
    expect(got).toBeNull();
  });

  it("resolveSessionByToken returns null for an unknown token", async () => {
    const got = await resolveSessionByToken(db, "tok-missing");
    expect(got).toBeNull();
  });

  it("deleteAdminSession returns true on hit, false on miss", async () => {
    await createAdminSession(db, {
      userId,
      token: "tok-del",
      expiresAt: new Date(Date.now() + 60_000),
      isAdmin: false,
    });
    expect(await deleteAdminSession(db, "tok-del")).toBe(true);
    expect(await deleteAdminSession(db, "tok-del")).toBe(false);
  });

  it("deleteAdminSessionsForUser removes all sessions for a user", async () => {
    await createAdminSession(db, {
      userId,
      token: "tok-u1",
      expiresAt: new Date(Date.now() + 60_000),
      isAdmin: false,
    });
    await createAdminSession(db, {
      userId,
      token: "tok-u2",
      expiresAt: new Date(Date.now() + 60_000),
      isAdmin: false,
    });
    const n = await deleteAdminSessionsForUser(db, userId);
    expect(n).toBe(2);
  });

  it("listActiveAdminSessions excludes expired rows", async () => {
    await createAdminSession(db, {
      userId,
      token: "tok-list-active",
      expiresAt: new Date(Date.now() + 60_000),
      isAdmin: false,
    });
    await createAdminSession(db, {
      userId,
      token: "tok-list-stale",
      expiresAt: new Date(Date.now() - 60_000),
      isAdmin: false,
    });
    const sessions = await listActiveAdminSessions(db);
    expect(sessions).toBeDefined(); // exercises the read path; details asserted below
    const all = await listActiveAdminSessions(db);
    expect(all.length).toBe(1);
    expect(all[0].userId).toBe(userId);
    expect(all[0].username).toBe("tester");
  });
});
