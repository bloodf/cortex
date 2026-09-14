// @vitest-environment node
/**
 * MP-002 — GET server-fn input must come from middleware-deserialized data,
 * not from the raw query string.
 *
 * Root cause: TanStack Start serializes a GET server-fn's input into a single
 * query parameter named `payload`. The pipeline's `readRequestInput` dumps
 * every query param into a plain object unchanged, so `safeParse` sees
 * `{ payload: "..." }` and a `.strict()` schema rejects the unknown `payload`
 * key. The fix (AN-001 Option B) threads the framework-deserialized `data`
 * (already available to the `.server()` middleware) through the runner into
 * the pipeline as `inputData`, bypassing the raw query.
 *
 * This file exercises the pipeline directly (same node-env harness pattern as
 * `define-server-fn.test.ts`): it constructs a `defineApiRoute` core with an
 * `inputData` option (simulating what the runner forwards from the framework
 * middleware context) and drives it with a crafted Web `Request`.
 *
 * T1 (RED before fix, GREEN after): a GET `Request` with `?payload=...`
 * PLUS middleware-provided `inputData: { q: 'x' }` → handler receives
 * `{ q: 'x' }`, no validation error.
 * T2 (GREEN before AND after): no `inputData`; a GET `Request` with plain
 * query params (`?q=x`) validates via `readRequestInput` as today.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";

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

let store: InMemorySessionStore;

beforeEach(() => {
  resetSessionStore();
  store = new InMemorySessionStore();
  setSessionStore(store);
  resetRateLimitBuckets();
});

function cookieHeader(parts: Record<string, string>): string {
  return Object.entries(parts)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("; ");
}

async function makeSession(): Promise<{ token: string }> {
  const csrf = generateSessionToken();
  const res = await store.createSession({
    username: "alice",
    csrfToken: csrf,
    ip: "127.0.0.1",
    userAgent: "vitest",
    isAdmin: false,
  });
  return { token: res.token };
}

describe("MP-002 — GET server-fn input from middleware data", () => {
  it("T1: GET input comes from middleware data, not raw query payload", async () => {
    const { token } = await makeSession();
    let captured: unknown;

    // The runner forwards `inputData` (the framework-deserialized data) to the
    // pipeline. We simulate this by passing `inputData` in the opts. Assign
    // to a variable first so the field is not hidden by inference
    // (the pipeline reads `opts.inputData` at runtime).
    const opts = {
      methods: ["GET"] as const,
      auth: "any" as const,
      input: z.object({ q: z.string().optional() }).strict(),
      surface: "system",
      action: "system.test.get-from-data",
      inputData: { q: "x" },
      handler: ({ input }: { input: unknown }) => {
        captured = input;
        return { ok: true };
      },
    };
    const core: ApiRouteCore = defineApiRoute(opts);

    const res = await core(
      new Request("http://localhost/_serverFn/probe?payload=ignored", {
        headers: { cookie: cookieHeader({ [SESSION_COOKIE]: token }) },
      }),
    );

    // Before the fix: pipeline reads `?payload=ignored` via readRequestInput,
    // gets `{ payload: 'ignored' }`, strict schema rejects with 400 +
    // 'Unrecognized key(s) in object: payload'. The handler never runs, so
    // `captured` stays undefined.
    expect(res.status).toBe(200);
    expect(captured).toEqual({ q: "x" });
  });

  it("T2: fallback to readRequestInput preserved when no inputData supplied", async () => {
    const { token } = await makeSession();
    let captured: unknown;

    const core: ApiRouteCore = defineApiRoute({
      methods: ["GET"],
      auth: "any",
      input: z.object({ q: z.string().optional() }).strict(),
      surface: "system",
      action: "system.test.fallback",
      handler: ({ input }: { input: unknown }) => {
        captured = input;
        return { ok: true };
      },
    });

    const res = await core(
      new Request("http://localhost/_serverFn/probe?q=x", {
        headers: { cookie: cookieHeader({ [SESSION_COOKIE]: token }) },
      }),
    );

    expect(res.status).toBe(200);
    expect(captured).toEqual({ q: "x" });
  });
});
