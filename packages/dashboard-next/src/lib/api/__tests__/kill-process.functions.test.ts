// @vitest-environment node
/**
 * killProcess gate tests. Drives the REAL killProcessGate through the
 * `defineApiRoute` pipeline and asserts the auth/CSRF/approval matrix is at
 * parity with the other destructive ops:
 *   - 403 for an authenticated non-admin.
 *   - 412 for an admin with valid CSRF but NO approval token.
 *   - success for admin + CSRF + a valid single-use approval token.
 *   - PID <= 1 is refused even with a valid token (bridge guard).
 *
 * Patterns copied from docker-prune.functions.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

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
import { mintApproval, resetApprovalStore } from "@/server/approval";

let store: InMemorySessionStore;
let killCore: ApiRouteCore;
let killSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  setServerHmacKeyFromString("kill-process-test-deterministic-key-0123456789ab");
  resetApprovalStore();
  resetSessionStore();
  store = new InMemorySessionStore();
  setSessionStore(store);
  resetRateLimitBuckets();

  // Never actually signal a process under test.
  killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

  const { killProcessGateOptions } = await import("../system.functions");
  killCore = defineApiRoute({
    methods: [killProcessGateOptions.method],
    auth: killProcessGateOptions.auth,
    input: killProcessGateOptions.input,
    rateLimit: killProcessGateOptions.rateLimit,
    approval: killProcessGateOptions.approval,
    surface: killProcessGateOptions.surface,
    action: killProcessGateOptions.action,
    target: killProcessGateOptions.target,
    handler: killProcessGateOptions.handler,
  });
});

afterEach(() => {
  killSpy.mockRestore();
});

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

function req(headers: Record<string, string>, body: unknown): Request {
  return new Request("http://localhost/_serverFn/processes.kill", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("processes.kill gate (auth: admin, approval: true)", () => {
  it("403 for an authenticated non-admin (valid CSRF)", async () => {
    const { token, csrf } = await makeSession({ isAdmin: false });
    const res = await killCore(
      req(
        {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "x-csrf-token": csrf,
        },
        { pid: 4242, signal: "SIGTERM" },
      ),
    );
    expect(res.status).toBe(403);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("412 for an admin with valid CSRF but NO approval token", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const res = await killCore(
      req(
        {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "x-csrf-token": csrf,
        },
        { pid: 4242, signal: "SIGTERM" },
      ),
    );
    expect(res.status).toBe(412);
    expect((await res.json()).code).toBe("approval_required");
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("succeeds for admin + CSRF + valid approval token and signals the PID", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const resolved = (await store.resolveByToken(token))!;
    const approval = mintApproval({
      action: "processes.kill",
      payload: { pid: 4242, signal: "SIGKILL" },
      sessionId: resolved.session.id,
      userId: resolved.user.id,
    });
    const res = await killCore(
      req(
        {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "x-csrf-token": csrf,
          "x-cortex-approval-token": approval.token,
        },
        { pid: 4242, signal: "SIGKILL" },
      ),
    );
    expect(res.status).toBeLessThan(300);
    expect((await res.json()).ok).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(4242, "SIGKILL");
  });

  it("refuses PID <= 1 even with a valid approval token", async () => {
    const { token, csrf } = await makeSession({ isAdmin: true });
    const resolved = (await store.resolveByToken(token))!;
    const approval = mintApproval({
      action: "processes.kill",
      payload: { pid: 1, signal: "SIGTERM" },
      sessionId: resolved.session.id,
      userId: resolved.user.id,
    });
    const res = await killCore(
      req(
        {
          cookie: cookieHeader({ [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }),
          "x-csrf-token": csrf,
          "x-cortex-approval-token": approval.token,
        },
        { pid: 1, signal: "SIGTERM" },
      ),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(killSpy).not.toHaveBeenCalled();
  });
});
