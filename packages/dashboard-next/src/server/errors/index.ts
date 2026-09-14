/**
 * Error helpers — map the contracts' `ApiError` discriminated union to
 * SvelteKit `error()` / `json()` responses.
 *
 * Public surface:
 *   - jsonError(error) → return a JSON Response (useful for +server.ts)
 *   - httpStatusFor(error) → map an `ApiError` to an HTTP status code
 *
 * Status mapping (per THREAT_MODEL §2 and HTTP spec):
 *   - validation         → 400
 *   - auth               → 401
 *   - permission         → 403
 *   - not_found          → 404
 *   - rate_limit         → 429  + Retry-After header
 *   - approval_required  → 403  + X-Cortex-Confirmation-Token header
 *   - system             → 500
 *   - conflict           → 409
 */

import type { ApiError } from "./types";

class ApiErrorThrown extends Error {
  public readonly apiError?: ApiError;
  constructor(
    public readonly status: number,
    public readonly body: { message: string; code?: string; details?: unknown },
    originalError?: ApiError,
  ) {
    super(body.message);
    this.name = "ApiErrorThrown";
    this.apiError = originalError;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Map an `ApiError` to its HTTP status code. */
export function httpStatusFor(error: ApiError): number {
  switch (error.kind) {
    case "validation":
      return 400;
    case "auth":
      return 401;
    case "permission":
    case "approval_required":
      return 403;
    case "not_found":
      return 404;
    case "rate_limit":
      return 429;
    case "system":
      return 500;
    case "conflict":
      return 409;
    case "bad_gateway":
      return 502;
    default:
      return 500;
  }
}

/**
 * Body shape returned to the client. Mirrors SvelteKit's `error()` payload
 * plus a `code` for machine consumption.
 */
export interface ApiErrorBody {
  message: string;
  code: ApiError["kind"];
  details?: unknown;
  /** For `approval_required`, the action hash the client should request a token for. */
  actionHash?: string;
  /** For `approval_required`, the suggested TTL in seconds. */
  ttlSec?: number;
}

export function errorBody(error: ApiError): ApiErrorBody {
  const base: ApiErrorBody = { message: error.message, code: error.kind };
  switch (error.kind) {
    case "validation":
      return { ...base, details: error.details };
    case "approval_required":
      return { ...base, actionHash: error.actionHash, ttlSec: error.ttlSec };
    case "conflict":
      // Spread the structured conflict payload top-level so clients read
      // `{ code: "conflict", blocked: true, dependents: [...] }` directly.
      return {
        ...base,
        ...(error.details !== null && typeof error.details === "object"
          ? (error.details as Record<string, unknown>)
          : {}),
      };
    default:
      return base;
  }
}

/**
 * Return a `Response` with the right status + headers for an `ApiError`.
 *
 * Use this in `+server.ts` when you want to return a JSON response rather
 * than letting SvelteKit render an error page. This is the right choice
 * for JSON-only API endpoints.
 */
export function jsonError(error: ApiError): Response {
  const status = httpStatusFor(error);
  const body = errorBody(error);
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
  };
  if (error.kind === "rate_limit") {
    headers["retry-after"] = String(error.retryAfter);
  }
  if (error.kind === "approval_required") {
    // The `X-Cortex-Confirmation-Token` header is the required signal that
    // an approval flow is in progress. The token itself is fetched via
    // POST /api/approvals/request.
    headers["x-cortex-confirmation-token-required"] = "true";
    headers["x-cortex-approval-action-hash"] = error.actionHash;
    headers["x-cortex-approval-ttl-sec"] = String(error.ttlSec);
  }
  return new Response(JSON.stringify(body), { status, headers });
}

/** Exposed for tests so they can assert the throw contract. */
export { ApiErrorThrown };
