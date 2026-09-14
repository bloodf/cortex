// @vitest-environment node
/**
 * P2 gate tests — incus read path (listInstances).
 *
 * Drives the REAL exported `incusListInstancesGateOptions` through the REAL
 * `defineApiRoute` pipeline (single source of truth for the gate + handler),
 * against the bridge's in-memory mock (seeded via `resetIncusBridgeForTests`)
 * so no live `incus` binary is touched. The list gate is `auth: any`:
 *   - 401 when unauthenticated
 *   - 200 with a valid session, returning the seeded instances
 */

import { describe, it, expect, beforeEach } from "vitest";

import {
  InMemorySessionStore,
  setSessionStore,
  resetSessionStore,
  generateSessionToken,
} from "@/server/auth/session-store";
import { SESSION_COOKIE } from "@/server/config";
import {
  defineApiRoute,
  resetRateLimitBuckets,
  type ApiRouteCore,
} from "@/server/server-fn-pipeline";
import { resetIncusBridgeForTests } from "@/server/incus/bridge";

import { incusListInstancesGateOptions } from "../incus.functions";

let store: InMemorySessionStore;

beforeEach(() => {
  resetSessionStore();
  store = new InMemorySessionStore();
  setSessionStore(store);
  resetRateLimitBuckets();
  // Seed the bridge's default in-memory mock so listInstances never hits the CLI.
  resetIncusBridgeForTests();
});

function cookieHeader(parts: Record<string, string>): string {
  return Object.entries(parts)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("; ");
}

async function makeSession(opts: { isAdmin: boolean }): Promise<{ token: string }> {
  const csrf = generateSessionToken();
  const res = await store.createSession({
    username: opts.isAdmin ? "admin" : "alice",
    csrfToken: csrf,
    ip: "127.0.0.1",
    userAgent: "vitest",
    isAdmin: opts.isAdmin,
  });
  return { token: res.token };
}

const listCore: ApiRouteCore = defineApiRoute({
  methods: [incusListInstancesGateOptions.method],
  auth: incusListInstancesGateOptions.auth,
  input: incusListInstancesGateOptions.input,
  surface: incusListInstancesGateOptions.surface,
  action: incusListInstancesGateOptions.action,
  handler: incusListInstancesGateOptions.handler,
});

describe("incus.instances.list gate (auth: any)", () => {
  it("401 without a session", async () => {
    const res = await listCore(new Request("http://localhost/_serverFn/incus.instances.list"));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("auth");
  });

  it("200 with a valid session → returns the seeded instances", async () => {
    const { token } = await makeSession({ isAdmin: false });
    const res = await listCore(
      new Request("http://localhost/_serverFn/incus.instances.list", {
        headers: { cookie: cookieHeader({ [SESSION_COOKIE]: token }) },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThan(0);
    // Real instance shape (not a UUID stub): a string name + status field.
    expect(typeof body.items[0].name).toBe("string");
    expect(typeof body.items[0].status).toBe("string");
  });
});
