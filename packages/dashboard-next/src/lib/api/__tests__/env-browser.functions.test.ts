// @vitest-environment node
/**
 * WP-18 env-browser gate + handler tests. SECURITY-SENSITIVE (secret reveal).
 *
 * Like the WP-20 auth tests, this exercises the REAL gate + handler via the
 * underlying `defineApiRoute` core (the `(Request) => Response` pipeline) — the
 * createServerFn compiler transform only runs in the Vite/Nitro build, so a bare
 * `await readEnv()` under vitest never invokes the extracted handler. We build
 * the cores from the SAME options objects the server fns use
 * (`readEnvGateOptions` / `unlockGateOptions`), so the behavior under test is
 * exactly what ships.
 *
 * No DB: `DB_PASSWORD` is unset → in-memory session store + FakePamAuthenticator
 * (pinned per-test). A real env file is written under an allowlisted prefix
 * (a temporary configured secrets root) so realpath and masking run for real.
 *
 * Security assertions:
 *   - masked by default: no cleartext secret leaves the server without a grant;
 *   - unlock with a valid PAM password → grant → reveal returns cleartext;
 *   - the grant is bound to ONE session (no cross-session leak).
 */

import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

import { runSequentially } from "@/lib/sequential";
import {
  InMemorySessionStore,
  setSessionStore,
  resetSessionStore,
} from "@/server/auth/session-store";
import {
  FakePamAuthenticator,
  setPamAuthenticator,
  resetPamAuthenticator,
} from "@/server/auth/pam";
import { SESSION_COOKIE, CSRF_COOKIE } from "@/server/config";
import {
  defineApiRoute,
  resetRateLimitBuckets,
  type ApiRouteCore,
} from "@/server/server-fn-pipeline";
import { resetRevealGrants } from "@/server/env-reveal";

import { listEnvFilesGateOptions, readEnvGateOptions, unlockGateOptions } from "../env-browser.functions";

const readEnvCore: ApiRouteCore = defineApiRoute({
  methods: [readEnvGateOptions.method],
  ...readEnvGateOptions,
});
const unlockCore: ApiRouteCore = defineApiRoute({
  methods: [unlockGateOptions.method],
  ...unlockGateOptions,
});

const listEnvCore: ApiRouteCore = defineApiRoute({
  methods: [listEnvFilesGateOptions.method],
  ...listEnvFilesGateOptions,
});

// A real env file under an allowlisted prefix. Created once; cleaned at the end.
const TMP_DIR = mkdtempSync(join(tmpdir(), "env-browser-"));
const ENV_PATH = join(TMP_DIR, "dashboard.env");
writeFileSync(
  ENV_PATH,
  [
    "# a comment",
    "DB_HOST=127.0.0.1",
    "DB_PASSWORD=super-secret-pw-123456",
    "API_TOKEN=tok_abcdefghijklmnop",
    "PLAIN=hello",
    "",
  ].join("\n"),
  { mode: 0o600 },
);

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(TMP_DIR, { recursive: true, force: true });
});

let store: InMemorySessionStore;
let pam: FakePamAuthenticator;

beforeEach(() => {
  vi.stubEnv("CORTEX_SECRETS_DIR", TMP_DIR);
  vi.stubEnv("CORTEX_ROOT", join(TMP_DIR, "installation"));
  resetSessionStore();
  store = new InMemorySessionStore();
  setSessionStore(store);
  resetPamAuthenticator();
  pam = new FakePamAuthenticator();
  setPamAuthenticator(pam);
  resetRateLimitBuckets();
  resetRevealGrants();
});

function cookieHeader(parts: Record<string, string>): string {
  return Object.entries(parts)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("; ");
}

async function makeAdminSession(username = "admin"): Promise<{ token: string; csrf: string }> {
  const csrf = "csrf-token-wp18";
  const created = await store.createSession({
    username,
    csrfToken: csrf,
    ip: "127.0.0.1",
    userAgent: "vitest",
    isAdmin: true,
  });
  return { token: created.token, csrf };
}

function readRequest(token: string, path: string): Request {
  const url = `http://localhost/_serverFn/env-browser.read?path=${encodeURIComponent(path)}`;
  return new Request(url, {
    headers: { cookie: cookieHeader({ [SESSION_COOKIE]: token }) },
  });
}

function unlockRequest(token: string, csrf: string, body: unknown): Request {
  return new Request("http://localhost/_serverFn/env-browser.unlock", {
    method: "POST",
    headers: {
      cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
      "content-type": "application/json",
      "x-csrf-token": csrf,
    },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// readEnv gate — auth: admin
// ---------------------------------------------------------------------------

describe("env-browser.read (auth: admin)", () => {
  it("401 without a session", async () => {
    const res = await readEnvCore(readRequest("nope", ENV_PATH));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("auth");
  });

  it("403 for a non-admin session", async () => {
    const created = await store.createSession({
      username: "bob",
      csrfToken: "c",
      ip: "127.0.0.1",
      userAgent: "vitest",
      isAdmin: false,
    });
    const res = await readEnvCore(readRequest(created.token, ENV_PATH));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("permission");
  });

  it("403 for a path outside the allowlist (e.g. /etc/passwd)", async () => {
    const { token } = await makeAdminSession();
    const res = await readEnvCore(readRequest(token, "/etc/passwd"));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("permission");
  });

  it("403 for a traversal that realpath-resolves outside the allowlist", async () => {
    const { token } = await makeAdminSession();
    const res = await readEnvCore(readRequest(token, `${TMP_DIR}/../../etc/passwd`));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("permission");
  });
});

describe("env-browser.list (auth and canonical allowlist)", () => {
  it("rejects unauthenticated discovery", async () => {
    const res = await listEnvCore(new Request("http://localhost/_serverFn/env-browser.list"));
    expect(res.status).toBe(401);
  });

  it("discovers configured env files without values or escaped symlink targets", async () => {
    const outside = mkdtempSync(join(tmpdir(), "env-outside-"));
    const link = join(TMP_DIR, "outside.env");
    writeFileSync(join(outside, "private.env"), "PASSWORD=never-disclose-this\n");
    symlinkSync(join(outside, "private.env"), link);
    try {
      const { token } = await makeAdminSession();
      const res = await listEnvCore(new Request("http://localhost/_serverFn/env-browser.list", {
        headers: { cookie: cookieHeader({ [SESSION_COOKIE]: token }) },
      }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ files: [ENV_PATH] });
      const escaped = await readEnvCore(readRequest(token, link));
      expect(escaped.status).toBe(403);
    } finally {
      rmSync(link, { force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Masked-by-default: NO cleartext secret without a grant
// ---------------------------------------------------------------------------

describe("env-browser.read — masked by default (no grant)", () => {
  it("returns masked secret values and never the cleartext", async () => {
    const { token } = await makeAdminSession();
    const res = await readEnvCore(readRequest(token, ENV_PATH));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.revealed).toBe(false);
    expect(body.revealExpiresAt).toBeNull();

    const byKey = new Map<string, { value: string; masked: string }>(
      body.entries.map((e: { key: string; value: string; masked: string }) => [e.key, e]),
    );

    // Secret keys are masked: `value` equals the masked string, NOT cleartext.
    const pw = byKey.get("DB_PASSWORD")!;
    expect(pw.value).toBe(pw.masked);
    expect(pw.value).not.toContain("super-secret-pw-123456");
    expect(pw.value).toContain("••••");

    const tok = byKey.get("API_TOKEN")!;
    expect(tok.value).toBe(tok.masked);
    expect(tok.value).not.toContain("tok_abcdefghijklmnop");

    // The full serialized response must not contain any cleartext secret.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("super-secret-pw-123456");
    expect(serialized).not.toContain("tok_abcdefghijklmnop");

    // Non-secret values pass through untouched.
    expect(byKey.get("DB_HOST")!.value).toBe("127.0.0.1");
    expect(byKey.get("PLAIN")!.value).toBe("hello");
  });
});

// ---------------------------------------------------------------------------
// unlock → grant → reveal
// ---------------------------------------------------------------------------

describe("env-browser.unlock (auth: admin, mutation)", () => {
  it("401 without a session", async () => {
    const res = await unlockCore(
      new Request("http://localhost/_serverFn/env-browser.unlock", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "x" }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("401 with wrong PAM password (coarse failure, no grant opened)", async () => {
    pam.setFakeUser({ username: "admin", password: "correct-horse", groups: ["cortexos-admin"] });
    const { token, csrf } = await makeAdminSession("admin");
    const res = await unlockCore(unlockRequest(token, csrf, { password: "wrong" }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("auth");
    // Coarse message — no PAM detail surfaced.
    expect(body.message).toBe("Password verification failed");

    // No grant was opened: a subsequent read is still masked.
    const read = await readEnvCore(readRequest(token, ENV_PATH));
    expect((await read.json()).revealed).toBe(false);
  });

  it("valid PAM password → grant within 10 min, then read returns cleartext", async () => {
    pam.setFakeUser({ username: "admin", password: "correct-horse", groups: ["cortexos-admin"] });
    const { token, csrf } = await makeAdminSession("admin");

    const before = Date.now();
    const res = await unlockCore(unlockRequest(token, csrf, { password: "correct-horse" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.ttlSec).toBe(600);
    // Expiry is within (now, now + 10min].
    expect(body.expiresAt).toBeGreaterThan(before);
    expect(body.expiresAt).toBeLessThanOrEqual(Date.now() + 10 * 60 * 1000);

    // The SAME session now reveals cleartext.
    const read = await readEnvCore(readRequest(token, ENV_PATH));
    expect(read.status).toBe(200);
    const revealed = await read.json();
    expect(revealed.revealed).toBe(true);
    expect(revealed.revealExpiresAt).toBe(body.expiresAt);

    const byKey = new Map<string, { value: string; masked: string }>(
      revealed.entries.map((e: { key: string; value: string; masked: string }) => [e.key, e]),
    );
    // Cleartext secret is now returned (value !== masked).
    expect(byKey.get("DB_PASSWORD")!.value).toBe("super-secret-pw-123456");
    expect(byKey.get("API_TOKEN")!.value).toBe("tok_abcdefghijklmnop");
  });

  it("grant does not leak across sessions (no cross-session reveal)", async () => {
    pam.setFakeUser({ username: "admin", password: "correct-horse", groups: ["cortexos-admin"] });
    // Session A unlocks.
    const a = await makeAdminSession("admin");
    const unlockA = await unlockCore(unlockRequest(a.token, a.csrf, { password: "correct-horse" }));
    expect(unlockA.status).toBe(201);

    // Session B (a different admin session) never unlocked.
    const b = await store.createSession({
      username: "admin2",
      csrfToken: "csrf-b",
      ip: "127.0.0.1",
      userAgent: "vitest",
      isAdmin: true,
    });

    // A reveals cleartext.
    const readA = await readEnvCore(readRequest(a.token, ENV_PATH));
    expect((await readA.json()).revealed).toBe(true);

    // B is still masked — the grant is bound to A's session only.
    const readB = await readEnvCore(readRequest(b.token, ENV_PATH));
    const bodyB = await readB.json();
    expect(bodyB.revealed).toBe(false);
    expect(JSON.stringify(bodyB)).not.toContain("super-secret-pw-123456");
  });

  it("rate-limited after 5 unlock attempts in the window (6th → 429)", async () => {
    pam.setFakeUser({ username: "admin", password: "correct-horse", groups: ["cortexos-admin"] });
    const { token, csrf } = await makeAdminSession("admin");
    const ress = await runSequentially(Array.from({ length: 6 }), async () =>
      unlockCore(unlockRequest(token, csrf, { password: "wrong" })),
    );
    const codes = ress.map((res) => res.status);
    // First 5 are processed (401 bad password); the 6th is rate-limited.
    expect(codes.slice(0, 5).every((c) => c === 401)).toBe(true);
    expect(codes[5]).toBe(429);
  });
});
