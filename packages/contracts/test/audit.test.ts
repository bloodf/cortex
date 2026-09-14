import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  hashRow,
  nextChainHash,
  verifyChain,
  canonicalJson,
  payloadHashOf,
  safeEqualHex,
  AUDIT_GENESIS_HASH,
  AuditEventSchema,
  AuditEntrySchema,
  AuditSurfaceSchema,
  AuditResultSchema,
  AuditDecisionSchema,
} from '../src/audit.js';

describe('audit — canonicalJson', () => {
  it('sorts object keys', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
  it('recursively sorts nested object keys', () => {
    expect(canonicalJson({ b: { y: 1, x: 2 }, a: 3 })).toBe('{"a":3,"b":{"x":2,"y":1}}');
  });
  it('handles arrays (order preserved)', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });
  it('handles primitives', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(false)).toBe('false');
    expect(canonicalJson(42)).toBe('42');
    expect(canonicalJson('hi')).toBe('"hi"');
  });
  it('rejects non-finite numbers', () => {
    expect(() => canonicalJson(Infinity)).toThrow();
    expect(() => canonicalJson(NaN)).toThrow();
  });
  it('produces the same hash for differently-ordered keys', () => {
    const a = payloadHashOf({ a: 1, b: 2, c: 3 });
    const b = payloadHashOf({ c: 3, b: 2, a: 1 });
    expect(a).toBe(b);
  });
});

describe('audit — payloadHashOf', () => {
  it('is a 64-char lowercase hex', () => {
    const h = payloadHashOf({ x: 1 });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
  it('matches a manual sha256 of the canonical JSON', () => {
    const payload = { a: 1, b: [1, 2, 3] };
    const expected = createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
    expect(payloadHashOf(payload)).toBe(expected);
  });
});

describe('audit — chain hash', () => {
  it('hashRow is deterministic', () => {
    const args = {
      prevId: 'id1',
      prevPayloadHash: 'a'.repeat(64),
      prevTsUnixMicros: 1700000000000000,
      prevCurrHash: 'b'.repeat(64),
    };
    expect(hashRow(args)).toBe(hashRow(args));
  });
  it('nextChainHash uses AUDIT_GENESIS_HASH when prev is null', () => {
    const h = nextChainHash({
      prevId: 'id1',
      prevPayloadHash: 'a'.repeat(64),
      prevTsUnixMicros: 0,
      prevCurrHash: null,
    });
    // The result must depend on the genesis hash.
    const h2 = nextChainHash({
      prevId: 'id1',
      prevPayloadHash: 'a'.repeat(64),
      prevTsUnixMicros: 0,
      prevCurrHash: AUDIT_GENESIS_HASH,
    });
    expect(h).toBe(h2);
  });
  it('produces a different hash for a different prevCurrHash', () => {
    const a = nextChainHash({
      prevId: 'id1',
      prevPayloadHash: 'a'.repeat(64),
      prevTsUnixMicros: 0,
      prevCurrHash: 'a'.repeat(64),
    });
    const b = nextChainHash({
      prevId: 'id1',
      prevPayloadHash: 'a'.repeat(64),
      prevTsUnixMicros: 0,
      prevCurrHash: 'b'.repeat(64),
    });
    expect(a).not.toBe(b);
  });
});

describe('audit — verifyChain', () => {
  const makeRow = (i: number, prevHash: string | null, ts: string) => ({
    id: `id_${i}`,
    ts,
    tsUnixMicros: 1700000000000000 + i * 1000,
    surface: 'admin_auth' as const,
    action: 'login',
    actorUserId: null,
    actorSessionId: null,
    actorIp: null,
    actorUserAgent: null,
    result: 'success' as const,
    decision: 'allow' as const,
    severity: 'info' as const,
    errorCode: null,
    requestId: null,
    payloadHash: payloadHashOf({ i }),
    payload: { i },
    prevHash,
    currHash: '',
  });

  it('returns null on an empty chain', () => {
    expect(verifyChain([])).toBeNull();
  });
  it('returns null on a valid 3-row chain', () => {
    const r0 = makeRow(0, null, '2026-01-01T00:00:00Z');
    r0.currHash = nextChainHash({
      prevId: r0.id,
      prevPayloadHash: r0.payloadHash,
      prevTsUnixMicros: r0.tsUnixMicros,
      prevCurrHash: null,
    });
    const r1 = makeRow(1, r0.currHash, '2026-01-01T00:00:01Z');
    r1.currHash = nextChainHash({
      prevId: r1.id,
      prevPayloadHash: r1.payloadHash,
      prevTsUnixMicros: r1.tsUnixMicros,
      prevCurrHash: r0.currHash,
    });
    const r2 = makeRow(2, r1.currHash, '2026-01-01T00:00:02Z');
    r2.currHash = nextChainHash({
      prevId: r2.id,
      prevPayloadHash: r2.payloadHash,
      prevTsUnixMicros: r2.tsUnixMicros,
      prevCurrHash: r1.currHash,
    });
    expect(verifyChain([r0, r1, r2])).toBeNull();
  });
  it('returns the index of the first break', () => {
    const r0 = makeRow(0, null, '2026-01-01T00:00:00Z');
    r0.currHash = 'a'.repeat(64);
    const r1 = makeRow(1, 'WRONG_HASH', '2026-01-01T00:00:01Z');
    r1.currHash = 'b'.repeat(64);
    expect(verifyChain([r0, r1])).toBe(1);
  });
  it('detects a non-null prevHash on row 0', () => {
    const r0 = makeRow(0, 'a'.repeat(64), '2026-01-01T00:00:00Z');
    r0.currHash = 'b'.repeat(64);
    expect(verifyChain([r0])).toBe(0);
  });
});

describe('audit — safeEqualHex', () => {
  it('returns true for equal 64-char hex', () => {
    expect(safeEqualHex('a'.repeat(64), 'a'.repeat(64))).toBe(true);
  });
  it('returns false for unequal hex', () => {
    expect(safeEqualHex('a'.repeat(64), 'b'.repeat(64))).toBe(false);
  });
  it('returns false for different-length strings', () => {
    expect(safeEqualHex('a'.repeat(64), 'a'.repeat(63))).toBe(false);
  });
  it('returns false for an odd-length hex', () => {
    expect(safeEqualHex('a'.repeat(63), 'a'.repeat(63))).toBe(false);
  });
  it('returns false for non-hex characters of valid length', () => {
    expect(safeEqualHex('z'.repeat(64), 'z'.repeat(64))).toBe(false);
  });
});

describe('audit — schemas', () => {
  it('AuditSurfaceSchema accepts every documented surface', () => {
    const surfaces = [
      'admin_auth',
      'rbac',
      'terminal',
      'systemd',
      'docker',
      'incus',
      'package_install',
      'env_browser',
      'logs',
      'audit_read',
      'audit_write',
      'ai_action',
      'local_network',
      'destructive_op',
      'e2e_mock',
      'cross_cutting',
      'rate_limit',
      'approval',
    ];
    surfaces.forEach((s) => {
      expect(AuditSurfaceSchema.parse(s)).toBe(s);
    });
  });
  it('AuditResultSchema accepts the documented values', () => {
    ['success', 'failure', 'denied', 'error', 'pending'].forEach((r) => {
      expect(AuditResultSchema.parse(r)).toBe(r);
    });
  });
  it('AuditDecisionSchema accepts the documented values', () => {
    ['allow', 'prompt', 'deny', 'timeout'].forEach((d) => {
      expect(AuditDecisionSchema.parse(d)).toBe(d);
    });
  });
  it('AuditSeveritySchema defaults to info', () => {
    const parsed = AuditEventSchema.parse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      ts: '2026-06-03T13:08:43-03:00',
      tsUnixMicros: 1700000000000000,
      surface: 'admin_auth',
      action: 'login',
      actorUserId: null,
      actorSessionId: null,
      actorIp: null,
      actorUserAgent: null,
      result: 'success',
      decision: 'allow',
      requestId: null,
      payloadHash: 'a'.repeat(64),
      payload: {},
      prevHash: null,
      currHash: 'b'.repeat(64),
    });
    expect(parsed.severity).toBe('info');
  });
  it('AuditEntrySchema rejects when chainValid is missing', () => {
    expect(() =>
      AuditEntrySchema.parse({
        id: '550e8400-e29b-41d4-a716-446655440000',
        ts: '2026-06-03T13:08:43-03:00',
        surface: 'admin_auth',
        action: 'login',
        actorUserId: null,
        actorIp: null,
        result: 'success',
        decision: 'allow',
        severity: 'info',
        prevHash: null,
        currHash: 'a'.repeat(64),
      }),
    ).toThrow();
  });
});
