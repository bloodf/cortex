/**
 * server-fn-pipeline — the framework-agnostic security pipeline behind
 * `defineServerFn` (WP-01). Server-runtime internal.
 *
 * ============================================================================
 * Transport: createServerFn RPC, NOT REST (see ADR-001)
 * ----------------------------------------------------------------------------
 * This TanStack Start version (@tanstack/react-start 1.168) has NO working
 * REST/HTTP server-route mechanism: a `/api/*` file route with `server.handlers`
 * registers in `routeTree.gen.ts` but 404s at runtime. The ONLY server
 * primitive is `createServerFn` (RPC). So this module is NOT consumed by a
 * route file — it is imported DYNAMICALLY by `src/lib/api/define-server-fn.ts`
 * (client-reachable, hence forbidden from statically importing `src/server/**`).
 *
 * `defineApiRoute(opts)` produces the proven core — a
 * `(request: Request) => Promise<Response>`. `defineServerFn` obtains the
 * incoming `Request` from the server-fn runtime (`getRequest()`), runs this
 * core, then either throws the non-2xx `Response` verbatim (typed-error
 * envelope) or returns the handler data with the accumulated Set-Cookie +
 * framework headers replayed onto the runtime response.
 *
 * Wave-1 WPs: do NOT write `/api/*` route files. Define server functions in
 * `src/lib/api/<domain>.functions.ts` via `defineServerFn(...)`. See ADR-001
 * and `STATUS.md` (Wave 0 note).
 * ============================================================================
 *
 * Pipeline (mirrors the legacy `route-helper.defineRoute`, adapted to Web
 * Request/Response + the TanStack `RequestCtx`):
 *   resolveContext → method match (405) → input parse/validate (400 + details)
 *   → auth/RBAC (401/403) → CSRF on non-GET (403; 401 if no session)
 *   → rate-limit (429 + Retry-After) → optional approval consume (412)
 *   → handler → safeAudit (never throws) → success (200/201) or typed error.
 *
 * Security note (WP-01): no gate is weakened to make a test pass. CSRF is
 * double-submit AND session-bound; RBAC admin is `cortexos-admin` only.
 */

import type { ZodType, ZodTypeDef } from "zod";
import type { GroupName, User } from "./entities";
import type { ApiError } from "./errors/types";
import { ApiErrorThrown, errorBody, httpStatusFor, jsonError } from "./errors";
import { isApiError } from "./errors/types";
import { audit, type AuditInput } from "./audit";
import { getDb } from "./db/client";
import { appendAuditLog } from "./db/repos/audit";
import { actionHashFor, consumeApproval } from "./approval";
import {
  resolveContext,
  maybeGcExpiredSessions,
  FRAMEWORK_HEADERS,
  type RequestCtx,
} from "./context";
import { requireAdmin, requireAuth, requireGroup } from "./auth/rbac";
import { requireCsrf } from "./auth/csrf";
import {
  RATE_LIMIT_DEFAULT_WINDOW_SEC,
  RATE_LIMIT_AUTHED_DEFAULT_PER_60S,
  RATE_LIMIT_TOKEN_MINT_PER_60S,
} from "./config";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type Handler<TIn, TOut> = (args: {
  user: User | null;
  input: TIn;
  ctx: RequestCtx;
}) => Promise<TOut> | TOut;

export interface RouteOptions<TIn, TOut> {
  /** HTTP methods this route accepts. */
  methods: readonly HttpMethod[];
  /** Optional input schema. Validated → 400 with field `details` on failure. */
  input?: ZodType<TIn, ZodTypeDef, unknown>;
  /** Required role: 'public' | 'any' | 'admin' | a specific group. */
  auth: "public" | "any" | "admin" | GroupName;
  /** Rate-limit configuration. Defaults applied per auth level when omitted. */
  rateLimit?: { limit: number; windowSec: number; bucket: "ip" | "user" };
  /** Surface name for the audit log. */
  surface: string;
  /** Action name for the audit log (e.g. `services.list`). */
  action: string;
  /** Target string for the audit log (typically a resource id). Never a secret. */
  target?: (input: TIn, ctx: RequestCtx) => string | null;
  /** Require + consume an approval token (`x-cortex-approval-token`). */
  approval?: boolean;
  /**
   * Pre-deserialized input forwarded by the runner from the TanStack Start
   * `.server()` middleware context (`data`). When supplied, the pipeline
   * validates THIS object instead of re-parsing the raw request — bypasses
   * the `?payload=<serialized>` envelope that GET server-fns travel in and
   * that `.strict()` schemas reject as an unknown key. `readRequestInput`
   * remains the fallback when `inputData` is `undefined` (direct-`Request`
   * tests, non-TanStack callers).
   */
  inputData?: TIn;
  /** The actual handler. */
  handler: Handler<TIn, TOut>;
}

/** A framework-agnostic core handler: Web Request in, Web Response out. */
export type ApiRouteCore = (request: Request) => Promise<Response>;

// ---------------------------------------------------------------------------
// Approval-token header
// ---------------------------------------------------------------------------

const APPROVAL_HEADER = "x-cortex-approval-token";

// ---------------------------------------------------------------------------
// In-process sliding-window rate limiter (ported from legacy rate-limit).
// Single-worker is acceptable for this deployment; a DB/Redis backend is a
// later concern. Kept local to the wrapper — the only consumer.
// ---------------------------------------------------------------------------

interface RateLimitResult {
  allowed: boolean;
  retryAfterSec: number;
}

const rateLimitBuckets = new Map<string, number[]>();

/** Test helper: clear all rate-limit buckets. */
export function resetRateLimitBuckets(): void {
  rateLimitBuckets.clear();
}

function checkRateLimit(key: string, limit: number, windowSec: number): RateLimitResult {
  const now = Date.now();
  const windowMs = windowSec * 1000;
  const cutoff = now - windowMs;
  let events = rateLimitBuckets.get(key);
  if (!events) {
    events = [];
    rateLimitBuckets.set(key, events);
  }
  while (events.length > 0 && events[0] < cutoff) events.shift();
  if (events.length >= limit) {
    const oldest = events[0];
    const retryAfterSec = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
    return { allowed: false, retryAfterSec };
  }
  events.push(now);
  return { allowed: true, retryAfterSec: 0 };
}

/** Default rate limit for an auth level (per `01-API-CONTRACT.md`). */
function defaultRateLimit(auth: RouteOptions<unknown, unknown>["auth"]): {
  limit: number;
  windowSec: number;
  bucket: "ip" | "user";
} {
  // unauth strict 30/min · authed reads 60/min · admin 30/min.
  // Privileged/expensive ops declare explicit per-gate limits (e.g. 10/min).
  if (auth === "public") {
    return {
      limit: RATE_LIMIT_TOKEN_MINT_PER_60S,
      windowSec: RATE_LIMIT_DEFAULT_WINDOW_SEC,
      bucket: "ip",
    };
  }
  if (auth === "admin") {
    return {
      limit: RATE_LIMIT_TOKEN_MINT_PER_60S,
      windowSec: RATE_LIMIT_DEFAULT_WINDOW_SEC,
      bucket: "user",
    };
  }
  return {
    limit: RATE_LIMIT_AUTHED_DEFAULT_PER_60S,
    windowSec: RATE_LIMIT_DEFAULT_WINDOW_SEC,
    bucket: "user",
  };
}

// ---------------------------------------------------------------------------
// Error serialization
// ---------------------------------------------------------------------------

/**
 * Serialize an `ApiError` to a `Response` matching `01-API-CONTRACT.md`. Most
 * codes go through WP-03's `jsonError`; `approval_required` is mapped to 412
 * here (the contract status) because WP-03's `httpStatusFor` returns 403 for
 * back-compat — we must not edit WP-03, so the wrapper owns the 412 status.
 */
function serializeError(error: ApiError): Response {
  if (error.kind === "approval_required") {
    const headers: Record<string, string> = {
      "content-type": "application/json; charset=utf-8",
      "x-cortex-confirmation-token-required": "true",
      "x-cortex-approval-action-hash": error.actionHash,
      "x-cortex-approval-ttl-sec": String(error.ttlSec),
    };
    return new Response(JSON.stringify(errorBody(error)), { status: 412, headers });
  }
  return jsonError(error);
}

/** Extract an `ApiError` from a thrown value (raw or `ApiErrorThrown`). */
function extractApiError(e: unknown): ApiError | null {
  if (isApiError(e)) return e;
  if (e instanceof ApiErrorThrown) {
    if (e.apiError) return e.apiError;
    // Reconstruct from the thrown body's code.
    const { code } = e.body;
    const { message } = e.body;
    switch (code) {
      case "auth":
        return { kind: "auth", message };
      case "permission":
        return { kind: "permission", message };
      case "validation":
        return {
          kind: "validation",
          message,
          details: Array.isArray(e.body.details)
            ? (e.body.details as readonly { field: string; message: string }[])
            : [],
        };
      case "not_found":
        return { kind: "not_found", message };
      case "rate_limit":
        return { kind: "rate_limit", message, retryAfter: 60 };
      case "system":
        return { kind: "system", message };
      default:
        return { kind: "system", message };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Response finalization — apply Set-Cookie + framework security headers.
// ---------------------------------------------------------------------------

function finalize(res: Response, ctx: RequestCtx): Response {
  ctx.cookies.applyTo(res.headers);
  Object.entries(FRAMEWORK_HEADERS).forEach(([name, value]) => {
    if (!res.headers.has(name)) res.headers.set(name, value);
  });
  // Surface the request ID to the client for log correlation (DX-08).
  if (ctx.requestId) res.headers.set("x-request-id", ctx.requestId);
  // Probabilistic session GC (best-effort; fire-and-forget).
  maybeGcExpiredSessions().catch(() => {});
  return res;
}

// ---------------------------------------------------------------------------
// Input reading
// ---------------------------------------------------------------------------

async function readRequestInput(request: Request): Promise<unknown> {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "DELETE") {
    const obj: Record<string, unknown> = {};
    Array.from(new URL(request.url).searchParams.entries()).forEach(([k, v]) => {
      obj[k] = v;
    });
    return obj;
  }
  const ct = request.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    try {
      return await request.json();
    } catch {
      return null;
    }
  }
  try {
    const fd = await request.formData();
    const out: Record<string, unknown> = {};
    Array.from(fd.entries()).forEach(([k, v]) => {
      if (typeof v === "string") {
        out[k] = v;
      }
    });
    return out;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Audit — never throws (ported from legacy safeAudit).
// ---------------------------------------------------------------------------

// Durable audit sink — serialize through an in-process queue so concurrent
// appends never race the hash-chain tip (single-process dashboard). Best-effort:
// a DB error (e.g. no DB under vitest) must never break the request.
let durableAuditTail: Promise<void> = Promise.resolve();
function persistDurableAudit(input: AuditInput): void {
  durableAuditTail = durableAuditTail
    .then(async () => {
      const payload: Record<string, unknown> = {
        ...input.payload,
        result: input.result,
        actorIp: input.actorIp,
        actorUserAgent: input.actorUserAgent,
        actorSessionId: input.actorSessionId,
        actorUserId: input.actorUserId,
        requestId: input.requestId ?? null,
        errorCode: input.errorCode,
      };
      await appendAuditLog(getDb(), {
        eventType: input.action,
        source: input.surface,
        subject: input.target,
        actor:
          input.actorUserId != null ? String(input.actorUserId) : (input.actorSessionId ?? null),
        payload,
      });
    })
    .catch((err) => {
      console.error("durable audit write failed:", err);
    });
}
/** Test helper: await all pending durable audit writes. */
export async function flushDurableAudit(): Promise<void> {
  await durableAuditTail;
}

function safeAudit<TIn>(
  ctx: RequestCtx,
  opts: RouteOptions<TIn, unknown>,
  user: User | null,
  err: ApiError | null,
  input: TIn | null,
  successData?: unknown,
): void {
  try {
    const target = opts.target ? opts.target(input as TIn, ctx) : null;
    let result: AuditInput["result"];
    if (err) {
      result = err.kind === "permission" || err.kind === "auth" ? "denied" : "failure";
    } else {
      result = "success";
    }
    const url = new URL(ctx.request.url);
    const basePayload: Record<string, unknown> = {
      method: ctx.request.method,
      path: url.pathname,
      query: url.search,
    };
    if (target) basePayload.target = target;
    if (err) basePayload.error = { kind: err.kind, message: err.message };
    if (successData !== undefined) basePayload.response_kind = typeof successData;
    const entry: AuditInput = {
      actorUserId: user?.id ?? null,
      actorSessionId: ctx.session?.id ?? null,
      actorIp: ctx.clientIp,
      actorUserAgent: ctx.userAgent,
      surface: opts.surface,
      action: opts.action,
      target,
      result,
      errorCode: err?.kind ?? null,
      requestId: ctx.requestId,
      payload: basePayload,
    };
    audit(entry);
    persistDurableAudit(entry);
  } catch {
    // Never let audit failures break the request.
  }
}

// ---------------------------------------------------------------------------
// Wrapper
// ---------------------------------------------------------------------------

export function defineApiRoute<TIn, TOut>(opts: RouteOptions<TIn, TOut>): ApiRouteCore {
  return async (request: Request): Promise<Response> => {
    const ctx = await resolveContext(request);
    const method = request.method.toUpperCase() as HttpMethod;

    // --- method match → 405 ---
    if (!opts.methods.includes(method)) {
      const allowMethods = opts.methods.join(", ");
      const res = new Response("Method not allowed", {
        status: 405,
        headers: { allow: allowMethods },
      });
      return finalize(res, ctx);
    }

    // --- 1. input parse + validate → 400 ---
    let input: TIn;
    if (opts.input) {
      const raw = opts.inputData !== undefined ? opts.inputData : await readRequestInput(request);
      const parsed = opts.input.safeParse(raw);
      if (!parsed.success) {
        const details = parsed.error.issues.map((i) => ({
          field: i.path.join(".") || "_root",
          message: i.message,
        }));
        const e: ApiError = { kind: "validation", message: "Validation failed", details };
        safeAudit(ctx, opts, null, e, null);
        return finalize(jsonError(e), ctx);
      }
      input = parsed.data;
    } else {
      input = {} as TIn;
    }

    // --- 2. auth / RBAC → 401 / 403 ---
    let user: User | null = null;
    if (opts.auth !== "public") {
      try {
        if (opts.auth === "admin") user = requireAdmin(ctx);
        else if (opts.auth === "any") user = requireAuth(ctx);
        else user = requireGroup(ctx, opts.auth);
      } catch (e) {
        const apiErr = extractApiError(e);
        if (apiErr) {
          safeAudit(ctx, opts, ctx.user, apiErr, input);
          return finalize(serializeError(apiErr), ctx);
        }
        throw e;
      }
    }

    // --- 3. CSRF on non-GET (double-submit + session-bound) ---
    // Public routes are pre-session (e.g. login): there is no session-bound
    // CSRF token to double-submit against, so the check is skipped for them
    // (WP-20: login is `auth:'public'`, CSRF skipped pre-session). This does
    // NOT weaken `any`/`admin`/group routes — every authenticated mutation
    // still enforces the full double-submit + session-bound CSRF below.
    if (opts.auth !== "public" && !["GET", "HEAD", "OPTIONS"].includes(method)) {
      try {
        requireCsrf(request, ctx.session?.csrfToken ?? null, ctx.cookies);
      } catch (e) {
        const apiErr = extractApiError(e);
        if (apiErr) {
          safeAudit(ctx, opts, user, apiErr, input);
          return finalize(serializeError(apiErr), ctx);
        }
        throw e;
      }
    }

    // --- 4. rate limit → 429 + Retry-After ---
    {
      const cfg = opts.rateLimit ?? defaultRateLimit(opts.auth);
      const route = new URL(request.url).pathname;
      const key =
        cfg.bucket === "ip" || !user ? `ip:${ctx.clientIp}:${route}` : `user:${user.id}:${route}`;
      const rl = checkRateLimit(key, cfg.limit, cfg.windowSec);
      if (!rl.allowed) {
        const e: ApiError = {
          kind: "rate_limit",
          message: "Too many requests",
          retryAfter: rl.retryAfterSec,
        };
        safeAudit(ctx, opts, user, e, input);
        return finalize(serializeError(e), ctx);
      }
    }

    // --- 5. approval consume (single-use, session + action bound) → 412 ---
    if (opts.approval) {
      const actionHash = actionHashFor(opts.action, input ?? {});
      const token = request.headers.get(APPROVAL_HEADER);
      const sessionId = ctx.session?.id ?? null;
      const result = token && sessionId ? consumeApproval(token, sessionId) : null;
      if (!result || !result.ok || result.claims.actionHash !== actionHash) {
        const e: ApiError = {
          kind: "approval_required",
          message: "This action requires a valid approval token",
          actionHash,
          ttlSec: 60,
        };
        safeAudit(ctx, opts, user, e, input);
        return finalize(serializeError(e), ctx);
      }
    }

    // --- 6. handler → audit → success / typed error ---
    try {
      const data = await opts.handler({ user, input, ctx });
      safeAudit(ctx, opts, user, null, input, data);
      const status = method === "POST" ? 201 : 200;
      const res = new Response(JSON.stringify(data ?? null), {
        status,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
      return finalize(res, ctx);
    } catch (e) {
      const apiErr = extractApiError(e);
      const finalErr: ApiError = apiErr ?? { kind: "system", message: "Internal error" };
      safeAudit(ctx, opts, user, finalErr, input);
      return finalize(serializeError(finalErr), ctx);
    }
  };
}

// Re-export for symmetry with the legacy route-helper.
export { httpStatusFor };
