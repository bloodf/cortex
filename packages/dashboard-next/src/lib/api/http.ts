/**
 * API error types for the CortexOS dashboard client (WP-04).
 *
 * The transport is createServerFn RPC (ADR-001) — the `request()` fetch helper
 * that previously lived here has been retired. These error types remain because:
 *   - The gate pipeline (`server-fn-pipeline.ts`) throws Response objects whose
 *     bodies match this error envelope; client code inspects `err.code`.
 *   - Wave-2 route WPs import `ApiClientError` for error-boundary handling.
 *
 * When the RPC layer returns a non-2xx Response, TanStack surfaces it as an
 * Error. Wrap it in an `ApiClientError` when you need typed access to `code`:
 *
 *   import { ApiClientError } from "@/lib/api/http";
 *   // or: import type { ApiClientError } from "@/lib/api/client";
 *
 *   try {
 *     await listServices({ data: {} });
 *   } catch (err) {
 *     if (err instanceof ApiClientError) {
 *       switch (err.code) {
 *         case "auth":               // 401 — redirect to login
 *         case "permission":         // 403 — access denied
 *         case "approval_required":  // 412 — open approvals flow
 *         case "rate_limit":         // 429 — err.retryAfter seconds
 *         case "validation":         // 400 — err.details has field messages
 *         case "not_found":          // 404
 *         case "system":             // 500
 *       }
 *     }
 *   }
 */

/** Error codes from the typed error envelope (01-API-CONTRACT.md). */
export type ApiErrorCode =
  | "validation"
  | "auth"
  | "permission"
  | "not_found"
  | "rate_limit"
  | "approval_required"
  | "system";

/** Typed error envelope as returned by the server. */
export interface ApiErrorEnvelope {
  code: ApiErrorCode;
  message: string;
  /** Present when code=validation */
  details?: { field: string; message: string }[];
  /** Present when code=rate_limit — seconds until retry */
  retryAfter?: number;
  /** Present when code=approval_required — action key for the approvals flow */
  action?: string;
  /** Present when code=approval_required — TTL in seconds for the approval token */
  ttlSec?: number;
}

/** Thrown by the client when the RPC gate returns a non-2xx error envelope. */
export class ApiClientError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details?: { field: string; message: string }[];
  readonly retryAfter?: number;
  readonly action?: string;
  readonly ttlSec?: number;

  constructor(envelope: ApiErrorEnvelope, status: number) {
    super(envelope.message);
    this.name = "ApiClientError";
    this.code = envelope.code;
    this.status = status;
    this.details = envelope.details;
    this.retryAfter = envelope.retryAfter;
    this.action = envelope.action;
    this.ttlSec = envelope.ttlSec;
  }
}
