/**
 * Local error model — mirrors the contracts package's
 * `packages/contracts/src/errors.ts` discriminated union.
 *
 * Once the contracts package is in place, swap to importing from there and
 * delete this file.
 */

export interface ValidationError {
  readonly kind: "validation";
  readonly message: string;
  /** Field-level details: `{ field: string, message: string }[]`. */
  readonly details: readonly { field: string; message: string }[];
}

export interface AuthError {
  readonly kind: "auth";
  readonly message: string;
}

export interface PermissionError {
  readonly kind: "permission";
  readonly message: string;
}

export interface NotFoundError {
  readonly kind: "not_found";
  readonly message: string;
  readonly resource?: string;
}

export interface RateLimitError {
  readonly kind: "rate_limit";
  readonly message: string;
  /** Seconds the client should wait before retrying. */
  readonly retryAfter: number;
}

export interface ApprovalRequiredError {
  readonly kind: "approval_required";
  readonly message: string;
  /** Action hash the client should request an approval token for. */
  readonly actionHash: string;
  /** Optional TTL hint in seconds. */
  readonly ttlSec: number;
}

export interface SystemError {
  readonly kind: "system";
  readonly message: string;
  /** Optional cause (not serialized to clients). */
  readonly cause?: unknown;
}

export interface ConflictError {
  readonly kind: "conflict";
  readonly message: string;
  /** Machine-readable conflict payload (e.g. `{ blocked: true, dependents: [...] }`). */
  readonly details?: unknown;
}

export interface BadGatewayError {
  readonly kind: "bad_gateway";
  readonly message: string;
  /** Optional cause (not serialized to clients). */
  readonly cause?: unknown;
}

export type ApiError =
  | ValidationError
  | AuthError
  | PermissionError
  | NotFoundError
  | RateLimitError
  | ApprovalRequiredError
  | SystemError
  | ConflictError
  | BadGatewayError;

/** Type guard: is this an `ApiError` (vs a plain Error or unknown throw)? */
export function isApiError(e: unknown): e is ApiError {
  if (typeof e !== "object" || e === null) return false;
  const k = (e as { kind?: unknown }).kind;
  return (
    k === "validation" ||
    k === "auth" ||
    k === "permission" ||
    k === "not_found" ||
    k === "rate_limit" ||
    k === "approval_required" ||
    k === "system" ||
    k === "conflict" ||
    k === "bad_gateway"
  );
}

/** Helper constructors — return typed `ApiError` values (Error instances so
 *  they satisfy `@typescript-eslint/only-throw-error`). */
export const validationError = (
  message: string,
  details: readonly { field: string; message: string }[] = [],
): ValidationError & Error =>
  Object.assign(new Error(message), { kind: "validation" as const, details });

export const authError = (message = "Authentication required"): AuthError & Error =>
  Object.assign(new Error(message), { kind: "auth" as const });

export const permissionError = (message = "Insufficient permissions"): PermissionError & Error =>
  Object.assign(new Error(message), { kind: "permission" as const });

export const notFoundError = (message = "Not found", resource?: string): NotFoundError & Error =>
  Object.assign(new Error(message), {
    kind: "not_found" as const,
    ...(resource ? { resource } : {}),
  });

export const rateLimitError = (retryAfter: number): RateLimitError & Error =>
  Object.assign(new Error("Too many requests"), { kind: "rate_limit" as const, retryAfter });

export const approvalRequiredError = (
  actionHash: string,
  ttlSec = 60,
): ApprovalRequiredError & Error =>
  Object.assign(new Error("This action requires an approval token"), {
    kind: "approval_required" as const,
    actionHash,
    ttlSec,
  });

export const systemError = (message: string, cause?: unknown): SystemError & Error =>
  Object.assign(new Error(message), {
    kind: "system" as const,
    ...(cause !== undefined ? { cause } : {}),
  });

export const conflictError = (message: string, details?: unknown): ConflictError & Error =>
  Object.assign(new Error(message), {
    kind: "conflict" as const,
    ...(details !== undefined ? { details } : {}),
  });

export const badGatewayError = (message: string, cause?: unknown): BadGatewayError & Error =>
  Object.assign(new Error(message), {
    kind: "bad_gateway" as const,
    ...(cause !== undefined ? { cause } : {}),
  });
