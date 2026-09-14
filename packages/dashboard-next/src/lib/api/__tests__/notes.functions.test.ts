// @vitest-environment node
/**
 * Phase 5 notes gate + handler tests — the markdown editor's security gates.
 *
 * Drives the REAL gate + handler via the `defineApiRoute` pipeline core (the
 * `(Request) => Response` object `defineServerFn` delegates to on the server)
 * with crafted Web `Request`s — same harness as systemd.functions.test.ts and
 * env-browser.functions.test.ts. The gate options under test are the exact
 * objects the shipped server fns use (single source of truth).
 *
 * Coverage:
 *   - listMdFiles  — admin-only (401/403), skips a bad dir without throwing
 *   - readMdFile   — path-traversal rejected (400), reads an allowlisted file
 *   - writeMdFile  — 401/403, 412 missing/wrong mint, 400 traversal,
 *                    success with a correct `notes.write` mint
 *   - `notes.write` on the mintable-action allowlist (isMintableAction)
 */

import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

import {
  InMemorySessionStore,
  setSessionStore,
  resetSessionStore,
  generateSessionToken,
} from "@/server/auth/session-store";
import { SESSION_COOKIE, CSRF_COOKIE, setServerHmacKeyFromString } from "@/server/config";
import {
  defineApiRoute,
  resetRateLimitBuckets,
  type ApiRouteCore,
} from "@/server/server-fn-pipeline";
import { mintApproval, resetApprovalStore, isMintableAction } from "@/server/approval";

import {
  listMdFilesGateOptions,
  readMdFileGateOptions,
  writeMdFileGateOptions,
} from "../notes.functions";

// ---------------------------------------------------------------------------
// Cores built from the SAME gate options the shipped server fns use.
// ---------------------------------------------------------------------------

const listCore: ApiRouteCore = defineApiRoute({
  methods: [listMdFilesGateOptions.method],
  ...listMdFilesGateOptions,
});
const readCore: ApiRouteCore = defineApiRoute({
  methods: [readMdFileGateOptions.method],
  ...readMdFileGateOptions,
});
const writeCore: ApiRouteCore = defineApiRoute({
  methods: [writeMdFileGateOptions.method],
  ...writeMdFileGateOptions,
});

// ---------------------------------------------------------------------------
// Fixtures — real markdown files under the allowlisted roots (scratch dirs,
// cleaned up after the run; never touch real docs).
// ---------------------------------------------------------------------------

const DOCS_DIR = mkdtempSync(join(tmpdir(), "notes-"));
const DOC_PATH = join(DOCS_DIR, "hello.md");
writeFileSync(DOC_PATH, "# Hello\n\nNotes test fixture.\n");

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(DOCS_DIR, { recursive: true, force: true });
});

let store: InMemorySessionStore;

beforeEach(() => {
  vi.stubEnv("CORTEX_NOTES_DOCS_ROOT", DOCS_DIR);
  vi.stubEnv("CORTEX_NOTES_PROMPTS_ROOT", join(DOCS_DIR, "prompts"));
  // Pin a deterministic HMAC key so minted approval tokens verify reproducibly.
  setServerHmacKeyFromString("notes-test-deterministic-key-0123456789");
  resetApprovalStore();
  resetSessionStore();
  store = new InMemorySessionStore();
  setSessionStore(store);
  resetRateLimitBuckets();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeSession(opts: { isAdmin: boolean }): Promise<{ token: string; csrf: string }> {
  const csrf = generateSessionToken();
  const res = await store.createSession({
    username: opts.isAdmin ? "admin" : "alice",
    csrfToken: csrf,
    ip: "127.0.0.1",
    userAgent: "vitest",
    isAdmin: opts.isAdmin,
  });
  return { token: res.token, csrf };
}

function cookieHeader(parts: Record<string, string>): string {
  return Object.entries(parts)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("; ");
}

function listRequest(token: string): Request {
  return new Request("http://localhost/_serverFn/notes.list", {
    headers: { cookie: cookieHeader({ [SESSION_COOKIE]: token }) },
  });
}

function readRequest(token: string, path: string): Request {
  const url = `http://localhost/_serverFn/notes.read?path=${encodeURIComponent(path)}`;
  return new Request(url, {
    headers: { cookie: cookieHeader({ [SESSION_COOKIE]: token }) },
  });
}

function writeRequest(token: string, csrf: string, body: unknown, approvalToken?: string): Request {
  const headers: Record<string, string> = {
    cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
    "content-type": "application/json",
    "x-csrf-token": csrf,
  };
  if (approvalToken) headers["x-cortex-approval-token"] = approvalToken;
  return new Request("http://localhost/_serverFn/notes.write", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// listMdFiles — auth: admin
// ---------------------------------------------------------------------------

describe("notes.list gate (auth: admin)", () => {
  it("401 without a session", async () => {
    const res = await listCore(new Request("http://localhost/_serverFn/notes.list"));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("auth");
  });

  it("403 for an authenticated non-admin", async () => {
    const { token } = await makeSession({ isAdmin: false });
    const res = await listCore(listRequest(token));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("permission");
  });

  it("200 for an admin; lists the fixture and reports the docs root", async () => {
    const { token } = await makeSession({ isAdmin: true });
    const res = await listCore(listRequest(token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { files: { path: string; name: string; root: string }[] };
    const fixture = body.files.find((f) => f.path === DOC_PATH);
    expect(fixture).toMatchObject({ name: "hello.md", root: "docs" });
    // Every reported file must sit under one of the two roots.
    for (const f of body.files) {
      expect(
        f.path.startsWith(`${DOCS_DIR}/`),
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// readMdFile — auth: admin, path guard
// ---------------------------------------------------------------------------

describe("notes.read gate (auth: admin, path-traversal guard)", () => {
  it("403 for an authenticated non-admin", async () => {
    const { token } = await makeSession({ isAdmin: false });
    const res = await readCore(readRequest(token, DOC_PATH));
    expect(res.status).toBe(403);
  });

  it("400 for a `..` traversal escaping the roots", async () => {
    const { token } = await makeSession({ isAdmin: true });
    const res = await readCore(readRequest(token, `${DOCS_DIR}/../../etc/passwd`));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("validation");
  });

  it("400 for an absolute path outside both roots", async () => {
    const { token } = await makeSession({ isAdmin: true });
    const res = await readCore(readRequest(token, "/etc/passwd"));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("validation");
  });

  it("200 reads an allowlisted file", async () => {
    const { token } = await makeSession({ isAdmin: true });
    const res = await readCore(readRequest(token, DOC_PATH));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string; content: string };
    expect(body.content).toContain("Notes test fixture.");
  });

  it("404 for a missing file inside a configured root", async () => {
    const { token } = await makeSession({ isAdmin: true });
    const res = await readCore(readRequest(token, join(DOCS_DIR, "no-such-file.md")));
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// writeMdFile — auth: admin, approval: true, path guard
// ---------------------------------------------------------------------------

describe("notes.write gate (auth: admin, approval: true)", () => {
  it("401 without any session", async () => {
    const res = await writeCore(
      new Request("http://localhost/_serverFn/notes.write", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: DOC_PATH, content: "x" }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("403 for an authenticated non-admin", async () => {
    const { token, csrf } = await makeSession({ isAdmin: false });
    const res = await writeCore(writeRequest(token, csrf, { path: DOC_PATH, content: "x" }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("permission");
  });

  it("412 for an admin with CSRF but no approval token", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const res = await writeCore(writeRequest(token, csrf, { path: DOC_PATH, content: "x" }));
    expect(res.status).toBe(412);
    expect((await res.json()).code).toBe("approval_required");
  });

  it("412 when the token is minted with the wrong action string", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const resolved = (await store.resolveByToken(token))!;
    const approval = mintApproval({
      action: "systemd.action", // wrong — gate hashes "notes.write"
      payload: { path: DOC_PATH, content: "mutated" },
      sessionId: resolved.session.id,
      userId: resolved.user.id,
    });
    const res = await writeCore(
      writeRequest(token, csrf, { path: DOC_PATH, content: "mutated" }, approval.token),
    );
    expect(res.status).toBe(412);
    expect((await res.json()).code).toBe("approval_required");
  });

  it("400 for a `..` traversal on write (escapes both roots)", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const resolved = (await store.resolveByToken(token))!;
    const payload = { path: `${DOCS_DIR}/../../tmp/evil.md`, content: "evil" };
    const approval = mintApproval({
      action: "notes.write",
      payload,
      sessionId: resolved.session.id,
      userId: resolved.user.id,
    });
    const res = await writeCore(writeRequest(token, csrf, payload, approval.token));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("validation");
  });

  it("201 writes with a correctly minted notes.write token", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const resolved = (await store.resolveByToken(token))!;
    const target = join(DOCS_DIR, "written.md");
    const payload = { path: target, content: "# Written\n\nby the gate test\n" };
    const approval = mintApproval({
      action: "notes.write",
      payload,
      sessionId: resolved.session.id,
      userId: resolved.user.id,
    });
    const res = await writeCore(writeRequest(token, csrf, payload, approval.token));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { path: string; bytes: number };
    expect(body.bytes).toBe(Buffer.byteLength(payload.content, "utf-8"));
    expect(readFileSync(target, "utf-8")).toBe(payload.content);
  });
});

// ---------------------------------------------------------------------------
// Mintable-action allowlist
// ---------------------------------------------------------------------------

describe("notes.write mintable allowlist", () => {
  it("notes.write is on the mintable-action allowlist", () => {
    expect(isMintableAction("notes.write")).toBe(true);
  });

  it("unrelated notes actions are NOT mintable (fail closed)", () => {
    expect(isMintableAction("notes.delete")).toBe(false);
  });
});
