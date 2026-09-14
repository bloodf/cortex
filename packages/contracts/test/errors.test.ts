import { describe, it, expect } from 'vitest';
import type { z } from 'zod';
import {
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
  CortexErrorSchema,
  ErrorCodeSchema,
  errorCodeOf,
  httpStatusFor,
} from '../src/errors.js';

const CASES: {
  name: string;
  schema: z.ZodTypeAny;
  expectedCode: string;
  expectedStatus: number;
  payload: Record<string, unknown>;
}[] = [
  {
    name: 'validation_error',
    schema: ValidationErrorSchema,
    expectedCode: 'validation_error',
    expectedStatus: 400,
    payload: { message: 'bad input', details: { issues: [] } },
  },
  {
    name: 'auth_required',
    schema: AuthRequiredErrorSchema,
    expectedCode: 'auth_required',
    expectedStatus: 401,
    payload: { message: 'login first' },
  },
  {
    name: 'auth_invalid',
    schema: AuthInvalidErrorSchema,
    expectedCode: 'auth_invalid',
    expectedStatus: 401,
    payload: { message: 'bad credentials' },
  },
  {
    name: 'permission_denied',
    schema: PermissionDeniedErrorSchema,
    expectedCode: 'permission_denied',
    expectedStatus: 403,
    payload: { message: 'admin only', requiredRole: 'cortexos-admin' },
  },
  {
    name: 'not_found',
    schema: NotFoundErrorSchema,
    expectedCode: 'not_found',
    expectedStatus: 404,
    payload: { message: 'no such service', resource: 'service' },
  },
  {
    name: 'conflict',
    schema: ConflictErrorSchema,
    expectedCode: 'conflict',
    expectedStatus: 409,
    payload: { message: 'already exists' },
  },
  {
    name: 'rate_limited',
    schema: RateLimitErrorSchema,
    expectedCode: 'rate_limited',
    expectedStatus: 429,
    payload: { message: 'slow down', retryAfter: 60, windowSec: 60, limit: 100 },
  },
  {
    name: 'approval_required',
    schema: ApprovalRequiredErrorSchema,
    expectedCode: 'approval_required',
    expectedStatus: 412,
    payload: {
      message: 'need approval',
      retryAfter: 60,
      actionHash: 'a'.repeat(64),
    },
  },
  {
    name: 'approval_expired',
    schema: ApprovalExpiredErrorSchema,
    expectedCode: 'approval_expired',
    expectedStatus: 410,
    payload: { message: 'token expired' },
  },
  {
    name: 'approval_replay',
    schema: ApprovalReplayErrorSchema,
    expectedCode: 'approval_replay',
    expectedStatus: 409,
    payload: { message: 'token already used' },
  },
  {
    name: 'dependency_failed',
    schema: DependencyFailedErrorSchema,
    expectedCode: 'dependency_failed',
    expectedStatus: 502,
    payload: { message: 'root-helper down', dependency: 'root-helper' },
  },
  {
    name: 'system_error',
    schema: SystemErrorSchema,
    expectedCode: 'system_error',
    expectedStatus: 500,
    payload: { message: 'unexpected' },
  },
];

describe('errors — CortexErrorSchema (discriminated union)', () => {
  CASES.forEach((c) => {
    it(`parses a valid ${c.name}`, () => {
      const result = CortexErrorSchema.safeParse({
        code: c.expectedCode,
        ...c.payload,
      });
      expect(result.success).toBe(true);
    });
    it(`rejects ${c.name} with the wrong code`, () => {
      const result = CortexErrorSchema.safeParse({
        code: 'something_else',
        ...c.payload,
      });
      expect(result.success).toBe(false);
    });
    it(`httpStatusFor(${c.name}) === ${c.expectedStatus}`, () => {
      const err = c.schema.parse({ code: c.expectedCode, ...c.payload });
      expect(httpStatusFor(err)).toBe(c.expectedStatus);
    });
  });

  it('rejects a payload missing the code field', () => {
    expect(() => CortexErrorSchema.parse({ message: 'no code' })).toThrow();
  });

  it('rejects a payload with an unknown code', () => {
    expect(() => CortexErrorSchema.parse({ code: 'not_a_real_code', message: 'x' })).toThrow();
  });
});

describe('errors — ErrorCodeSchema', () => {
  it('rejects unknown codes', () => {
    expect(() => ErrorCodeSchema.parse('not_a_code')).toThrow();
  });
  it('accepts every documented code', () => {
    const codes = [
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
    ];
    codes.forEach((c) => {
      expect(ErrorCodeSchema.parse(c)).toBe(c);
    });
  });
});

describe('errors — errorCodeOf', () => {
  it('returns the code from a parsed error', () => {
    const err = NotFoundErrorSchema.parse({
      code: 'not_found',
      message: 'gone',
    });
    expect(errorCodeOf(err)).toBe('not_found');
  });
  it('returns "unknown" for non-error values', () => {
    expect(errorCodeOf(null)).toBe('unknown');
    expect(errorCodeOf({ code: 'not_in_registry' })).toBe('unknown');
    expect(errorCodeOf('a string')).toBe('unknown');
  });
});

describe('errors — httpStatusFor', () => {
  it('maps every code to a 4xx or 5xx', () => {
    const codes = [
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
    ];
    codes.forEach((code) => {
      const err = CortexErrorSchema.parse({ code, message: 'x' });
      const status = httpStatusFor(err);
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
    });
  });
});
