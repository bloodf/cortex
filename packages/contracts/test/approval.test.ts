import { describe, it, expect } from 'vitest';
import {
  actionHashOf,
  issueApprovalToken,
  verifyApprovalToken,
  ttlForClass,
  APPROVAL_TTL_DESTRUCTIVE_SEC,
  APPROVAL_TTL_REVEAL_SEC,
  APPROVAL_GRACE_SEC,
  APPROVAL_TOKEN_HEADER,
  ApprovalRequestPayloadSchema,
  ApprovalResponseSchema,
  ApprovalClassSchema,
  ApprovalTokenSchema,
} from '../src/approval.js';
import { userId as makeUserId, sessionId as makeSessionId } from '../src/primitives.js';

const SECRET = 'test-secret-do-not-use-in-prod';
const FIXED_DATE = new Date('2026-06-03T13:08:43Z');
const TEST_USER_ID = '550e8400-e29b-41d4-a716-446655440000';
const TEST_SESSION_ID = 'sess_abc123def';

describe('approval — actionHashOf', () => {
  it('produces a 64-char hex', () => {
    const h = actionHashOf('systemd.restart:cortex-dashboard');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
  it('is deterministic', () => {
    const a = actionHashOf({ tool: 'x', args: { y: 1 } });
    const b = actionHashOf({ tool: 'x', args: { y: 1 } });
    expect(a).toBe(b);
  });
  it('is sensitive to key order', () => {
    const a = actionHashOf({ x: 1, y: 2 });
    const b = actionHashOf({ y: 2, x: 1 });
    // The canonicalJson sort ensures order-independence, so these
    // are EQUAL. Document the contract.
    expect(a).toBe(b);
  });
  it('produces different hashes for different actions', () => {
    expect(actionHashOf('a')).not.toBe(actionHashOf('b'));
  });
});

describe('approval — ttlForClass', () => {
  it('destructive = 60s', () => {
    expect(ttlForClass('destructive')).toBe(APPROVAL_TTL_DESTRUCTIVE_SEC);
  });
  it('reveal = 300s', () => {
    expect(ttlForClass('reveal')).toBe(APPROVAL_TTL_REVEAL_SEC);
  });
});

describe('approval — issue + verify (happy path)', () => {
  it('round-trips a valid token', () => {
    const actionHash = actionHashOf('systemd.restart:cortex-dashboard');
    const issued = issueApprovalToken({
      actionHash,
      sessionId: makeSessionId(TEST_SESSION_ID),
      userId: makeUserId(TEST_USER_ID),
      class: 'destructive',
      secret: SECRET,
      now: FIXED_DATE,
    });
    // Token is the wire format
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    // Claims
    expect(issued.claims.actionHash).toBe(actionHash);
    expect(issued.claims.class).toBe('destructive');
    expect(issued.claims.exp - issued.claims.iat).toBe(60);
    // ExpiresAt
    expect(issued.expiresAt.getTime()).toBe(
      Math.floor(FIXED_DATE.getTime() / 1000) * 1000 + 60_000,
    );

    // Verify with the right actionHash and sessionId
    let live = true;
    const claims = verifyApprovalToken({
      token: issued.token,
      expectedActionHash: actionHash,
      expectedSessionId: makeSessionId(TEST_SESSION_ID),
      secret: SECRET,
      now: FIXED_DATE,
      isLive: () => live,
      markConsumed: () => {
        live = false;
      },
    });
    expect(claims).not.toBeNull();
    expect(claims?.actionHash).toBe(actionHash);
  });
});

describe('approval — verify (failure cases)', () => {
  const baseIssue = () =>
    issueApprovalToken({
      actionHash: actionHashOf('docker.action:start'),
      sessionId: makeSessionId('sess_1'),
      userId: makeUserId(TEST_USER_ID),
      class: 'destructive',
      secret: SECRET,
      now: FIXED_DATE,
    });

  it('rejects a wrong action hash', () => {
    const { token } = baseIssue();
    const result = verifyApprovalToken({
      token,
      expectedActionHash: actionHashOf('something-else'),
      expectedSessionId: makeSessionId('sess_1'),
      secret: SECRET,
      now: FIXED_DATE,
      isLive: () => true,
      markConsumed: () => {},
    });
    expect(result).toBeNull();
  });

  it('rejects a wrong session id', () => {
    const { token } = baseIssue();
    const result = verifyApprovalToken({
      token,
      expectedActionHash: actionHashOf('docker.action:start'),
      expectedSessionId: makeSessionId('sess_OTHER'),
      secret: SECRET,
      now: FIXED_DATE,
      isLive: () => true,
      markConsumed: () => {},
    });
    expect(result).toBeNull();
  });

  it('rejects a wrong secret', () => {
    const { token } = baseIssue();
    const result = verifyApprovalToken({
      token,
      expectedActionHash: actionHashOf('docker.action:start'),
      expectedSessionId: makeSessionId('sess_1'),
      secret: 'different-secret',
      now: FIXED_DATE,
      isLive: () => true,
      markConsumed: () => {},
    });
    expect(result).toBeNull();
  });

  it('rejects an expired token', () => {
    const { token, claims } = baseIssue();
    const future = new Date((claims.exp + 60) * 1000);
    const result = verifyApprovalToken({
      token,
      expectedActionHash: actionHashOf('docker.action:start'),
      expectedSessionId: makeSessionId('sess_1'),
      secret: SECRET,
      now: future,
      isLive: () => true,
      markConsumed: () => {},
    });
    expect(result).toBeNull();
  });

  it('rejects an already-consumed token (SR-121 single-use)', () => {
    const { token } = baseIssue();
    const result = verifyApprovalToken({
      token,
      expectedActionHash: actionHashOf('docker.action:start'),
      expectedSessionId: makeSessionId('sess_1'),
      secret: SECRET,
      now: FIXED_DATE,
      isLive: () => false, // already consumed
      markConsumed: () => {},
    });
    expect(result).toBeNull();
  });

  it('rejects a malformed token', () => {
    const result = verifyApprovalToken({
      token: 'not-a-token',
      expectedActionHash: actionHashOf('docker.action:start'),
      expectedSessionId: makeSessionId('sess_1'),
      secret: SECRET,
      now: FIXED_DATE,
      isLive: () => true,
      markConsumed: () => {},
    });
    expect(result).toBeNull();
  });

  it('rejects a token with no dot separator', () => {
    const result = verifyApprovalToken({
      token: 'nodothere',
      expectedActionHash: actionHashOf('docker.action:start'),
      expectedSessionId: makeSessionId('sess_1'),
      secret: SECRET,
      now: FIXED_DATE,
      isLive: () => true,
      markConsumed: () => {},
    });
    expect(result).toBeNull();
  });
});

describe('approval — schemas', () => {
  it('ApprovalClassSchema accepts the documented set', () => {
    ['destructive', 'privileged', 'reveal', 'write'].forEach((c) => {
      expect(ApprovalClassSchema.parse(c)).toBe(c);
    });
  });
  it('ApprovalClassSchema rejects unknown classes', () => {
    expect(() => ApprovalClassSchema.parse('mystery')).toThrow();
  });
  it('ApprovalRequestPayloadSchema requires a phrase and action hash', () => {
    expect(() =>
      ApprovalRequestPayloadSchema.parse({
        actionHash: 'a'.repeat(64),
        class: 'destructive',
      }),
    ).toThrow();
    expect(() =>
      ApprovalRequestPayloadSchema.parse({
        actionHash: 'not-64-chars',
        phrase: 'DELETE foo',
        class: 'destructive',
      }),
    ).toThrow();
  });
  it('ApprovalRequestPayloadSchema accepts a valid request', () => {
    const parsed = ApprovalRequestPayloadSchema.parse({
      actionHash: 'a'.repeat(64),
      phrase: 'DELETE cortex-dashboard',
      class: 'destructive',
      description: 'restart cortex-dashboard',
    });
    expect(parsed.phrase).toBe('DELETE cortex-dashboard');
    expect(parsed.class).toBe('destructive');
  });
  it('ApprovalResponseSchema requires graceSec=5', () => {
    expect(() =>
      ApprovalResponseSchema.parse({
        token: 'x.y',
        expiresAt: '2026-06-03T13:09:43-03:00',
        actionHash: 'a'.repeat(64),
        class: 'destructive',
        graceSec: 6,
      }),
    ).toThrow();
  });
  it('ApprovalTokenSchema requires a dot-separated format', () => {
    expect(() => ApprovalTokenSchema.parse('no-dot-here')).toThrow();
    expect(() => ApprovalTokenSchema.parse('a.b.c.d')).toThrow();
  });
});

describe('approval — constants', () => {
  it('exposes the canonical header name', () => {
    expect(APPROVAL_TOKEN_HEADER).toBe('x-cortex-approval-token');
  });
  it('the grace constant is 5s', () => {
    expect(APPROVAL_GRACE_SEC).toBe(5);
  });
});
