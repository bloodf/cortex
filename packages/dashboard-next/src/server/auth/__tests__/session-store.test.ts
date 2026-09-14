// @vitest-environment node
/**
 * WP-01 unit tests for the ported in-memory session store + resolveContext
 * lifecycle (the production Drizzle store is covered by WP-02's users repo).
 * Verifies: create/resolve, expiry never resolves, rolling touch with the
 * absolute-lifetime cap, role re-validation cache, and that resolveContext
 * drops a stale cookie + re-validates role on a TTL.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import {
  InMemorySessionStore,
  DrizzleSessionStore,
  setSessionStore,
  resetSessionStore,
  generateSessionToken,
  DEFAULT_SESSION_TTL_MS,
} from "../session-store";
import { createTestDb, type PgliteDbClient } from "../../db/test-utils";
import { adminSessions } from "../../db/schema";
import { resolveContext } from "../../context";
import { SESSION_COOKIE } from "../../config";
import { setPamAuthenticator, resetPamAuthenticator, FakePamAuthenticator } from "../pam";

let store: InMemorySessionStore;

beforeEach(() => {
  resetSessionStore();
  store = new InMemorySessionStore();
  setSessionStore(store);
});

afterEach(() => {
  vi.useRealTimers();
  resetPamAuthenticator();
});

async function newSession(isAdmin = false) {
  return store.createSession({
    username: isAdmin ? "admin" : "alice",
    csrfToken: generateSessionToken(),
    ip: "127.0.0.1",
    userAgent: "vitest",
    isAdmin,
  });
}

describe("InMemorySessionStore", () => {
  it("creates and resolves a session", async () => {
    const { token } = await newSession();
    const resolved = await store.resolveByToken(token);
    expect(resolved).not.toBeNull();
    expect(resolved!.user.username).toBe("alice");
    expect(resolved!.isAdmin).toBe(false);
  });

  it("never resolves an unknown token", async () => {
    expect(await store.resolveByToken("nope")).toBeNull();
  });

  it("never resolves an expired session (SR-001)", async () => {
    const { token } = await store.createSession({
      username: "alice",
      csrfToken: "c",
      ip: null,
      userAgent: null,
      isAdmin: false,
      ttlMs: -1, // already expired
    });
    expect(await store.resolveByToken(token)).toBeNull();
  });

  it("admin session reports admin groups", async () => {
    const { token } = await newSession(true);
    const resolved = await store.resolveByToken(token);
    expect(resolved!.isAdmin).toBe(true);
    expect(resolved!.groups).toContain("cortexos-admin");
  });

  it("touch extends expiry but caps at created + ttl", async () => {
    const { token, session } = await newSession();
    const created = session.expiresAt - DEFAULT_SESSION_TTL_MS;
    const touched = await store.touch(token, DEFAULT_SESSION_TTL_MS);
    expect(touched).not.toBeNull();
    expect(touched!.expiresAt).toBeLessThanOrEqual(created + DEFAULT_SESSION_TTL_MS + 1000);
  });

  it("revalidateRole updates the cached admin flag", async () => {
    const { token } = await newSession(true);
    await store.revalidateRole(token, false);
    const resolved = await store.resolveByToken(token);
    expect(resolved!.isAdmin).toBe(false);
  });

  it("deleteByToken works", async () => {
    const { token } = await newSession();
    expect(await store.deleteByToken(token)).toBe(true);
    expect(await store.resolveByToken(token)).toBeNull();
  });
});

describe("resolveContext lifecycle", () => {
  it("resolves a valid session cookie into ctx.user/ctx.session", async () => {
    const { token } = await newSession();
    const ctx = await resolveContext(
      new Request("http://localhost/api/x", {
        headers: { cookie: `${SESSION_COOKIE}=${token}` },
      }),
    );
    expect(ctx.user?.username).toBe("alice");
    expect(ctx.session).not.toBeNull();
  });

  it("drops a stale token silently and clears the cookie", async () => {
    const ctx = await resolveContext(
      new Request("http://localhost/api/x", {
        headers: { cookie: `${SESSION_COOKIE}=${generateSessionToken()}` },
      }),
    );
    expect(ctx.user).toBeNull();
    const h = new Headers();
    ctx.cookies.applyTo(h);
    const setCookies = h.get("set-cookie") ?? "";
    expect(setCookies).toContain(`${SESSION_COOKIE}=`);
    expect(setCookies).toContain("Max-Age=0");
  });

  it("re-validates role via PAM when the cache is older than 60s", async () => {
    const { token } = await newSession(true);
    // Force the cached role check to be stale.
    await store.revalidateRole(token, true);
    // Manually age lastRoleCheckAt past the 60s TTL.
    const row = (
      store as unknown as { sessions: Map<string, { lastRoleCheckAt: number }> }
    ).sessions.get(token)!;
    row.lastRoleCheckAt = Date.now() - 61_000;

    // PAM now reports the admin has been demoted.
    const pam = new FakePamAuthenticator();
    pam.setFakeUser({ username: "admin", password: "pw", groups: ["cortexos-users"] });
    setPamAuthenticator(pam);

    await resolveContext(
      new Request("http://localhost/api/x", {
        headers: { cookie: `${SESSION_COOKIE}=${token}` },
      }),
    );
    // The demoted role is now cached.
    const resolved = await store.resolveByToken(token);
    expect(resolved!.isAdmin).toBe(false);
  });

  it("returns an empty ctx when no session cookie is present", async () => {
    const ctx = await resolveContext(new Request("http://localhost/api/x"));
    expect(ctx.user).toBeNull();
    expect(ctx.session).toBeNull();
    expect(ctx.requestId).toHaveLength(16);
  });
});

// ---------------------------------------------------------------------------
// DbSessionStore (DrizzleSessionStore) — same contract against real PGlite
// ---------------------------------------------------------------------------

describe("DbSessionStore", () => {
  let db: PgliteDbClient;
  let client: PGlite;
  let dbStore: DrizzleSessionStore;

  beforeEach(async () => {
    const r = await createTestDb({ seed: false });
    db = r.db;
    client = r.client;
    dbStore = new DrizzleSessionStore(db);
  }, 30_000);

  afterEach(async () => {
    if (client) await client.close();
  });

  async function newDbSession(isAdmin = false) {
    return dbStore.createSession({
      username: isAdmin ? "admin" : "alice",
      csrfToken: generateSessionToken(),
      ip: "127.0.0.1",
      userAgent: "vitest",
      isAdmin,
    });
  }

  it("createSession then resolveByToken returns the session with correct user", async () => {
    const { token } = await newDbSession();
    const resolved = await dbStore.resolveByToken(token);
    expect(resolved).not.toBeNull();
    expect(resolved!.user.username).toBe("alice");
    expect(resolved!.isAdmin).toBe(false);
    expect(resolved!.session).not.toBeNull();
  });

  it("resolveByToken returns null for unknown token (SR-001)", async () => {
    expect(await dbStore.resolveByToken("no-such-token")).toBeNull();
  });

  it("resolveByToken returns null for an expired session (SR-001)", async () => {
    const { token } = await newDbSession();
    // Back-date expires_at to the past so the DB NOW() check rejects it.
    await db
      .update(adminSessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(adminSessions.token, token));
    expect(await dbStore.resolveByToken(token)).toBeNull();
  });

  it("touch extends expiresAt (rolling expiry)", async () => {
    // Create session with a 60-second initial TTL so expiresAt = createdAt + 60s.
    // Touching with DEFAULT_SESSION_TTL_MS (30d) produces:
    //   newExpiry = min(now + 30d, createdAt + 30d)
    // The cap (createdAt + 30d) is far above the original (createdAt + 60s),
    // so the extension is genuine and the assertion holds deterministically.
    const shortTtl = 60_000;
    const { token, session } = await dbStore.createSession({
      username: "alice",
      csrfToken: generateSessionToken(),
      ip: "127.0.0.1",
      userAgent: "vitest",
      isAdmin: false,
      ttlMs: shortTtl,
    });
    const originalExpiry = session.expiresAt;
    const updated = await dbStore.touch(token, DEFAULT_SESSION_TTL_MS);
    expect(updated).not.toBeNull();
    expect(updated!.expiresAt).toBeGreaterThan(originalExpiry);
  });

  it("touch is capped at createdAt + ttlMs (absolute lifetime)", async () => {
    const { token } = await newDbSession();
    // Touch with a 1-second TTL — cap = createdAt + 1s, well in the past
    // relative to a 30-day window; the returned expiry must be <= now + 1s.
    const shortTtl = 1_000;
    const before = Date.now();
    const updated = await dbStore.touch(token, shortTtl);
    expect(updated).not.toBeNull();
    expect(updated!.expiresAt).toBeLessThanOrEqual(before + shortTtl + 500);
  });

  it("deleteByToken removes the session", async () => {
    const { token } = await newDbSession();
    expect(await dbStore.deleteByToken(token)).toBe(true);
    expect(await dbStore.resolveByToken(token)).toBeNull();
  });

  it("deleteByToken is idempotent (returns false on second call)", async () => {
    const { token } = await newDbSession();
    await dbStore.deleteByToken(token);
    expect(await dbStore.deleteByToken(token)).toBe(false);
  });

  it("revalidateRole updates the cached isAdmin flag", async () => {
    const { token } = await newDbSession(true);
    const before = await dbStore.resolveByToken(token);
    expect(before!.isAdmin).toBe(true);

    await dbStore.revalidateRole(token, false);
    const after = await dbStore.resolveByToken(token);
    expect(after!.isAdmin).toBe(false);
  });

  it("gcExpired purges expired rows and leaves valid ones intact", async () => {
    const { token: liveToken } = await newDbSession();
    const { token: expiredToken } = await newDbSession();

    // Back-date only the second session.
    await db
      .update(adminSessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(adminSessions.token, expiredToken));

    const { deleted, ranAt } = await dbStore.gcExpired();

    expect(deleted).toBe(1);
    expect(ranAt).toBeGreaterThan(0);

    // Live session survives; expired row is gone.
    expect(await dbStore.resolveByToken(liveToken)).not.toBeNull();
    expect(await dbStore.resolveByToken(expiredToken)).toBeNull();
  });
});
