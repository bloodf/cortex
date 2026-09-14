// @vitest-environment node
/**
 * WP-19 gate tests — the security gates the terminal server functions enforce.
 *
 * Like the WP-13 systemd tests, this exercises the gate via the underlying
 * `defineApiRoute` core (the `(Request) => Response` pipeline). The auth/RBAC/
 * CSRF/rate-limit matrix is asserted WITHOUT spawning a process; the terminal
 * bridge itself is exercised in `src/server/terminal/__tests__/pty-bridge.test.ts`.
 *
 * The handler bodies below mirror what `defineServerFn` produces for
 * `listTerminalOps` (GET admin) and `dispatchTerminalOp` (POST admin,
 * rate-limit 10/min/user), including the allowlist + arg-smuggling guards.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";

import {
  InMemorySessionStore,
  setSessionStore,
  resetSessionStore,
  generateSessionToken,
} from "@/server/auth/session-store";
import { SESSION_COOKIE, CSRF_COOKIE } from "@/server/config";
import {
  defineApiRoute,
  resetRateLimitBuckets,
  type ApiRouteCore,
} from "@/server/server-fn-pipeline";
import { dispatch, validateAllArgs, setExecutorForTests } from "@/server/terminal/pty-bridge";
import { allowlistedCommand } from "@/server/policy";
import { validationError, permissionError } from "@/server/errors/types";

let store: InMemorySessionStore;

beforeEach(() => {
  resetSessionStore();
  store = new InMemorySessionStore();
  setSessionStore(store);
  resetRateLimitBuckets();
  process.env.CORTEX_TERMINAL_BRIDGE_REAL = "0";
  setExecutorForTests(null);
});

// ---------------------------------------------------------------------------
// Gate cores (same shape defineServerFn produces).
// ---------------------------------------------------------------------------

const listOpsCore: ApiRouteCore = defineApiRoute({
  methods: ["GET"],
  auth: "admin",
  input: z.object({}).strict(),
  rateLimit: { limit: 30, windowSec: 60, bucket: "user" },
  surface: "terminal",
  action: "terminal.list-ops",
  handler: async () => {
    const { listTerminalOps } = await import("@/server/terminal/pty-bridge");
    return { ops: listTerminalOps() };
  },
});

const dispatchCore: ApiRouteCore = defineApiRoute({
  methods: ["POST"],
  auth: "admin",
  input: z
    .object({
      op: z.string().min(1).max(64),
      args: z.record(z.string(), z.unknown()).default({}),
    })
    .strict(),
  rateLimit: { limit: 10, windowSec: 60, bucket: "user" },
  surface: "terminal",
  action: "terminal.dispatch",
  target: (i) => (i as { op: string }).op,
  handler: async ({ input, user, ctx }) => {
    const i = input;
    const entry = allowlistedCommand(i.op);
    if (!entry || entry.surface !== "terminal") {
      throw permissionError(`Unsupported terminal op: ${i.op}`);
    }
    const argHits = validateAllArgs(i.args);
    if (argHits.length > 0) {
      throw validationError(
        "Arg validation failed",
        argHits.map((h) => ({ field: h.field || "_root", message: h.reason })),
      );
    }
    const result = await dispatch(
      { op: i.op, args: i.args },
      {
        user: user!,
        ip: ctx.clientIp ?? "unknown",
        userAgent: ctx.userAgent ?? null,
        requestId: ctx.requestId,
      },
    );
    if (result.status === "rejected") {
      if (
        result.code === "arg_smuggling" ||
        result.code === "argv_bash_c" ||
        result.code === "unknown_op"
      ) {
        throw permissionError(result.reason);
      }
      throw validationError(result.reason, [
        ...(result.field ? [{ field: result.field, message: result.reason }] : []),
        { field: "op", message: result.code },
      ]);
    }
    return {
      op: result.op,
      argv: result.argv,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
    };
  },
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

// ---------------------------------------------------------------------------
// listTerminalOps — auth: admin
// ---------------------------------------------------------------------------

describe("terminal.list-ops gate (auth: admin)", () => {
  it("200 + ops for an admin session", async () => {
    const { token } = await makeSession({ isAdmin: true });
    const res = await listOpsCore(
      new Request("http://localhost/_serverFn/terminal.list-ops", {
        headers: { cookie: cookieHeader({ [SESSION_COOKIE]: token }) },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ops.map((o: { op: string }) => o.op)).toEqual(
      expect.arrayContaining(["term.ps", "term.df", "term.ls", "term.tail_log"]),
    );
    expect(body.ops.map((o: { op: string }) => o.op)).not.toContain("term.exec_named");
  });

  it("403 for an authenticated non-admin", async () => {
    const { token } = await makeSession({ isAdmin: false });
    const res = await listOpsCore(
      new Request("http://localhost/_serverFn/terminal.list-ops", {
        headers: { cookie: cookieHeader({ [SESSION_COOKIE]: token }) },
      }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("permission");
  });

  it("401 without a session", async () => {
    const res = await listOpsCore(new Request("http://localhost/_serverFn/terminal.list-ops"));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("auth");
  });
});

// ---------------------------------------------------------------------------
// dispatchTerminalOp — auth: admin (CSRF-enforced mutation)
// ---------------------------------------------------------------------------

describe("terminal.dispatch gate (auth: admin)", () => {
  function postReq(body: unknown, headers: Record<string, string>): Request {
    return new Request("http://localhost/_serverFn/terminal.dispatch", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }

  it("401 without any session", async () => {
    const res = await dispatchCore(postReq({ op: "term.ps", args: {} }, {}));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("auth");
  });

  it("403 for an authenticated non-admin", async () => {
    const { token, csrf } = await makeSession({ isAdmin: false });
    const res = await dispatchCore(
      postReq(
        { op: "term.ps", args: {} },
        {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "x-csrf-token": csrf,
        },
      ),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("permission");
  });

  it("403 for an admin missing the CSRF header (stolen-cookie attack)", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const res = await dispatchCore(
      postReq(
        { op: "term.ps", args: {} },
        { cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }) },
      ),
    );
    expect(res.status).toBe(403);
  });

  it("201 for an admin running term.ps with valid CSRF (mock executor)", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const res = await dispatchCore(
      postReq(
        { op: "term.ps", args: {} },
        {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "x-csrf-token": csrf,
        },
      ),
    );
    // Pipeline returns 201 for a successful POST mutation (WP-01 evidence).
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.exitCode).toBe(0);
    expect(body.argv).toEqual(["ps", "auxf"]);
    expect(body.stdout).toContain("ps auxf");
  });

  it("400 for a shell metacharacter in an arg (injection blocked)", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const res = await dispatchCore(
      postReq(
        { op: "term.tail_log", args: { unit: "caddy; rm -rf /", N: 10 } },
        {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "x-csrf-token": csrf,
        },
      ),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("validation");
  });

  it("403 for an unknown / non-allowlisted op (no bash -c)", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const res = await dispatchCore(
      postReq(
        { op: "term.nonexistent", args: {} },
        {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "x-csrf-token": csrf,
        },
      ),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("permission");
  });
});
