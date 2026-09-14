/**
 * Discriminated-union error model for CortexOS contracts.
 *
 * Every server response that fails — and every client-side validation
 * rejection — produces one of these errors. The shape is a closed set;
 * consumers should exhaustively `switch` on `code` to render the right UI.
 *
 * The `details` field is reserved for structured context (e.g. Zod issues,
 * a map of field → message). The `retryAfter` field is populated for
 * `RateLimitError` and `ApprovalRequiredError` so the client can back off
 * or schedule a retry without parsing a `Retry-After` HTTP header.
 *
 * @module
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Error code registry — every concrete error has one of these codes.
// ---------------------------------------------------------------------------

/**
 * The full set of error codes. Adding a new code is a wire-format change:
 * every consumer that switches on `code` will need a new branch. Do not add
 * codes without updating both the client error renderer and the contract
 * test suite.
 */
export const ErrorCodeSchema = z.enum([
  'validation_error',
  'auth_required',
  'auth_invalid',
  'permission_denied',
  'not_found',
  'conflict',
  'rate_limited',
  'approval_required',
  'approval_expired',
  'approval_replay',
  'dependency_failed',
  'system_error',
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

// ---------------------------------------------------------------------------
// Per-error details
// ---------------------------------------------------------------------------

/** Zod-style issue: path + message + code. */
export const ZodIssueSchema = z.object({
  path: z.array(z.union([z.string(), z.number()])),
  message: z.string().min(1).max(500),
  code: z.string().min(1).max(64).optional(),
});
export type ZodIssue = z.infer<typeof ZodIssueSchema>;

/** Field-level message map, e.g. for forms. */
export const FieldErrorsSchema = z.record(z.string(), z.array(z.string()));
export type FieldErrors = z.infer<typeof FieldErrorsSchema>;

// ---------------------------------------------------------------------------
// The discriminated union
// ---------------------------------------------------------------------------

const BaseError = {
  /** Human-readable summary. Safe to show in toasts but NOT in chat replies. */
  message: z.string().min(1).max(2000),
  /** Trace identifier for log correlation. Never user-facing. */
  traceId: z.string().min(1).max(128).optional(),
  /** Free-form context. Shape depends on `code`; documented per-code below. */
  details: z.record(z.string(), z.unknown()).optional(),
};

/**
 * Validation failed on the request body / params. The `details` MAY contain
 * a `ZodIssue[]` under the key `issues` and/or a `FieldErrors` under `fields`.
 */
export const ValidationErrorSchema = z.object({
  code: z.literal('validation_error'),
  ...BaseError,
});
export type ValidationError = z.infer<typeof ValidationErrorSchema>;

/** No valid session cookie / bearer token. Maps to HTTP 401. */
export const AuthRequiredErrorSchema = z.object({
  code: z.literal('auth_required'),
  ...BaseError,
});
export type AuthRequiredError = z.infer<typeof AuthRequiredErrorSchema>;

/** Credentials were rejected. Maps to HTTP 401. */
export const AuthInvalidErrorSchema = z.object({
  code: z.literal('auth_invalid'),
  ...BaseError,
});
export type AuthInvalidError = z.infer<typeof AuthInvalidErrorSchema>;

/** Authenticated but not authorized. Maps to HTTP 403. */
export const PermissionDeniedErrorSchema = z.object({
  code: z.literal('permission_denied'),
  ...BaseError,
  /** The required role or capability, when applicable. */
  requiredRole: z.string().min(1).max(64).optional(),
});
export type PermissionDeniedError = z.infer<typeof PermissionDeniedErrorSchema>;

/** The target resource does not exist. Maps to HTTP 404. */
export const NotFoundErrorSchema = z.object({
  code: z.literal('not_found'),
  ...BaseError,
  /** What was not found: a stable resource kind (e.g. "service", "user"). */
  resource: z.string().min(1).max(64).optional(),
});
export type NotFoundError = z.infer<typeof NotFoundErrorSchema>;

/** Optimistic-concurrency conflict or duplicate-key. Maps to HTTP 409. */
export const ConflictErrorSchema = z.object({
  code: z.literal('conflict'),
  ...BaseError,
});
export type ConflictError = z.infer<typeof ConflictErrorSchema>;

/** Per-IP or per-user quota exceeded. Maps to HTTP 429. */
export const RateLimitErrorSchema = z.object({
  code: z.literal('rate_limited'),
  ...BaseError,
  /** Seconds until the client may try again. */
  retryAfter: z.number().int().min(0).max(86_400).optional(),
  /** Window size in seconds, for client-side backoff logic. */
  windowSec: z.number().int().min(1).max(86_400).optional(),
  /** Quota for the window. */
  limit: z.number().int().min(1).max(1_000_000).optional(),
});
export type RateLimitError = z.infer<typeof RateLimitErrorSchema>;

/**
 * A destructive or privileged action requires an approval token that the
 * caller did not supply. Maps to HTTP 412 (Precondition Required).
 *
 * The client should re-issue the action with `X-Cortex-Approval-Token`
 * after acquiring one via the approval flow.
 */
export const ApprovalRequiredErrorSchema = z.object({
  code: z.literal('approval_required'),
  ...BaseError,
  /** Seconds the user has to complete the approval flow. */
  retryAfter: z.number().int().min(0).max(300).optional(),
  /** Action hash the token must match. */
  actionHash: z.string().min(1).max(128).optional(),
});
export type ApprovalRequiredError = z.infer<typeof ApprovalRequiredErrorSchema>;

/** The approval token has expired. Maps to HTTP 410 Gone. */
export const ApprovalExpiredErrorSchema = z.object({
  code: z.literal('approval_expired'),
  ...BaseError,
});
export type ApprovalExpiredError = z.infer<typeof ApprovalExpiredErrorSchema>;

/** The approval token was already consumed (single-use). Maps to HTTP 409. */
export const ApprovalReplayErrorSchema = z.object({
  code: z.literal('approval_replay'),
  ...BaseError,
});
export type ApprovalReplayError = z.infer<typeof ApprovalReplayErrorSchema>;

/** A dependency (e.g. root-helper, LLM endpoint) returned an error. Maps to HTTP 502. */
export const DependencyFailedErrorSchema = z.object({
  code: z.literal('dependency_failed'),
  ...BaseError,
  /** The failing dependency, e.g. "root-helper", "llm-endpoint". */
  dependency: z.string().min(1).max(64).optional(),
});
export type DependencyFailedError = z.infer<typeof DependencyFailedErrorSchema>;

/** Catch-all for unexpected server-side failures. Maps to HTTP 500. */
export const SystemErrorSchema = z.object({
  code: z.literal('system_error'),
  ...BaseError,
});
export type SystemError = z.infer<typeof SystemErrorSchema>;

/** The discriminated union of every error the dashboard can produce. */
export const CortexErrorSchema = z.discriminatedUnion('code', [
  ValidationErrorSchema,
  AuthRequiredErrorSchema,
  AuthInvalidErrorSchema,
  PermissionDeniedErrorSchema,
  NotFoundErrorSchema,
  ConflictErrorSchema,
  RateLimitErrorSchema,
  ApprovalRequiredErrorSchema,
  ApprovalExpiredErrorSchema,
  ApprovalReplayErrorSchema,
  DependencyFailedErrorSchema,
  SystemErrorSchema,
]);
export type CortexError = z.infer<typeof CortexErrorSchema>;

/** Extract a code from an unknown thrown value. Best-effort. */
export const errorCodeOf = (e: unknown): ErrorCode | 'unknown' => {
  if (typeof e === 'object' && e !== null && 'code' in e) {
    const { code } = e;
    if (typeof code === 'string') {
      const result = ErrorCodeSchema.safeParse(code);
      if (result.success) return result.data;
    }
  }
  return 'unknown';
};

/** The HTTP status code that each error maps to. */
export const httpStatusFor = (e: CortexError): number => {
  switch (e.code) {
    case 'validation_error':
      return 400;
    case 'auth_required':
    case 'auth_invalid':
      return 401;
    case 'permission_denied':
      return 403;
    case 'not_found':
      return 404;
    case 'conflict':
    case 'approval_replay':
      return 409;
    case 'approval_required':
      return 412;
    case 'rate_limited':
      return 429;
    case 'dependency_failed':
      return 502;
    case 'approval_expired':
      return 410;
    case 'system_error':
      return 500;
    default:
      return 500;
  }
};
