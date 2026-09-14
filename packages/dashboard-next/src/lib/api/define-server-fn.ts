/**
 * defineServerFn — the single security gate every CortexOS server function uses
 * (WP-01, the createServerFn-RPC rework of the old REST `defineApiRoute`).
 *
 * ============================================================================
 * Shape: a function MIDDLEWARE (not a finished server fn) — and WHY
 * ----------------------------------------------------------------------------
 * This TanStack Start version's compiler REQUIRES every `createServerFn(...)`
 * to be assigned to a top-level variable ("createServerFn must be assigned to a
 * variable!"), and it only EXTRACTS (server-strips) a `.handler()` body when the
 * `createServerFn` literal sits at module top level. A factory that internally
 * did `return createServerFn(...).handler(...)` therefore (a) fails the compiler
 * and (b) leaves the handler's dynamic `src/server/**` import in the CLIENT
 * bundle, tripping import-protection (`Denied by file pattern: src/server`).
 *
 * `createMiddleware().server(...)` bodies, by contrast, ARE extracted even when
 * built inside a factory. So `defineServerFn(opts)` returns a per-fn gate
 * MIDDLEWARE that carries the entire security pipeline + the business handler;
 * the call site writes the (compiler-legal, top-level) server-fn literal:
 *
 *   import { createServerFn } from '@tanstack/react-start';
 *   import { defineServerFn, serverFnNoop } from '@/lib/api/define-server-fn';
 *   import { z } from 'zod';
 *
 *   const gate = defineServerFn({
 *     method: 'GET',
 *     auth: 'any',
 *     input: z.object({ q: z.string().optional() }),
 *     surface: 'services',
 *     action: 'services.list',
 *     handler: async ({ input, user }) => {
 *       const { listServices } = await import('@/server/services/repo');
 *       return listServices(input.q);
 *     },
 *   });
 *   export const listServices = createServerFn({ method: 'GET' })
 *     .middleware([gate])
 *     .handler(serverFnNoop);
 *
 * The `handler` you pass to `defineServerFn` is invoked INSIDE the extracted
 * gate, so its dynamic `await import('@/server/...')` is server-only. The
 * top-level `.handler(serverFnNoop)` is a trivial passthrough — the gate sets
 * the result.
 *
 * ============================================================================
 * How the gate runs (createServerFn server runtime)
 * ----------------------------------------------------------------------------
 * The gate middleware runs ONLY in the server runtime. It delegates to the
 * `.server.ts` runner (`server-fn-runner.server.ts`, dynamically imported so the
 * client never references `src/server`), which:
 *   1. reads the live Web `Request` via `getRequest()` (cookies/headers/method);
 *   2. runs the proven `(Request) => Response` pipeline — resolveContext →
 *      method/input/auth/CSRF/rate-limit/approval → handler → audit → typed
 *      success/error envelope;
 *   3. on a gate FAILURE throws the non-2xx `Response` (the RPC handler returns
 *      a thrown `Response` verbatim — status + body + headers preserved — which
 *      is how the typed error envelope + correct HTTP status reach the client);
 *   4. on SUCCESS replays the pipeline's Set-Cookie + framework security headers
 *      onto the runtime response via `setCookie`/`setResponseHeader` and returns
 *      the handler DATA (idiomatic typed RPC — the client gets the value).
 *
 * A bare `await listServices()` outside the runtime throws `No Start context
 * found in AsyncLocalStorage` — expected, and NOT a gate result.
 *
 * TanStack's built-in `createCsrfMiddleware` guards the RPC transport (rejects
 * cross-site server-fn calls); we additionally enforce our own double-submit,
 * session-bound CSRF on every mutation inside the pipeline (a stolen CSRF cookie
 * alone must never pass) — defence in depth, never weakened.
 *
 * Security note (WP-01): no gate is weakened to make a test pass.
 * ============================================================================
 */

import { createMiddleware } from "@tanstack/react-start";
import type { ZodType, ZodTypeDef } from "zod";

import type { GroupName, User } from "@/server/entities";
import type { RequestCtx } from "@/server/context";

// ---------------------------------------------------------------------------
// Public option + handler shapes (mirror the legacy `defineApiRoute` signature)
// ---------------------------------------------------------------------------

export type ServerFnMethod = "GET" | "POST";

export type ServerFnHandler<TIn, TOut> = (args: {
  user: User | null;
  input: TIn;
  ctx: RequestCtx;
}) => Promise<TOut> | TOut;

export interface ServerFnOptions<TIn, TOut> {
  /** RPC transport method. `GET` for reads, `POST` for mutations. */
  method: ServerFnMethod;
  /** Required role: 'public' | 'any' | 'admin' | a specific group. */
  auth: "public" | "any" | "admin" | GroupName;
  /** Optional input schema. Validated → 400 (`{code:'validation', details}`). */
  input?: ZodType<TIn, ZodTypeDef, unknown>;
  /** Rate-limit override. Defaults applied per auth level when omitted. */
  rateLimit?: { limit: number; windowSec: number; bucket: "ip" | "user" };
  /** Surface name for the audit log. */
  surface: string;
  /** Action name for the audit log (e.g. `services.delete`). */
  action: string;
  /** Audit target (typically a resource id). Never a secret. */
  target?: (input: TIn, ctx: RequestCtx) => string | null;
  /** Require + consume a single-use approval token (`x-cortex-approval-token`). */
  approval?: boolean;
  /** The business-logic handler. Throw typed `ApiError`s from `@/server/errors`. */
  handler: ServerFnHandler<TIn, TOut>;
}

/**
 * Trivial passthrough handler for the top-level `createServerFn` literal — the
 * gate middleware computes and sets the result, so this never produces data.
 */
export const serverFnNoop = (): undefined => undefined;

// ---------------------------------------------------------------------------
// Factory — returns the per-fn gate middleware
// ---------------------------------------------------------------------------

/**
 * Build the security-gate middleware for a server function. Attach it to a
 * top-level `createServerFn(...).middleware([gate]).handler(serverFnNoop)`.
 *
 * The middleware's `.server()` body is extracted by the compiler (server-only),
 * so the dynamic `import('./server-fn-runner.server')` — and through it the
 * whole `src/server` pipeline + your handler's `await import('@/server/...')` —
 * is severed from the client bundle.
 */
export function defineServerFn<TIn = unknown, TOut = unknown>(opts: ServerFnOptions<TIn, TOut>) {
  return createMiddleware({ type: "function" }).server(async ({ data, next }) => {
    const runServerFnGate = (await import("./server-fn-runner.server")).default;
    const result = await runServerFnGate<TIn, TOut>({
      methods: [opts.method],
      auth: opts.auth,
      input: opts.input,
      rateLimit: opts.rateLimit,
      surface: opts.surface,
      action: opts.action,
      target: opts.target,
      approval: opts.approval,
      handler: opts.handler,
      inputData: data,
    });
    return next({ result } as never);
  });
}
