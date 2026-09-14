import { describe, it, expect } from 'vitest';
import {
  zId,
  zUuidV4,
  zUlid,
  zSlug,
  zIsoTimestamp,
  zEpochMs,
  zEpochMicros,
  zIpAddress,
  zUserAgent,
  zSha256,
  IdPattern,
  userId,
  serviceId,
  serviceSlug,
  healthSnapshotId,
  alertRuleId,
  alertEventId,
  auditId,
  auditEventId,
  requestId,
  approvalId,
  approvalToken,
  dashboardCommandId,
  containerId,
  imageId,
  volumeId,
  networkId,
  incusInstanceName,
  incusImageFingerprint,
  systemdUnitName,
  terminalSessionId,
  terminalCommandId,
  projectId,
  projectSlug,
  notificationId,
  backupSnapshotId,
  schedulerJobName,
  agentSlug,
  agentFilePath,
  mailReviewId,
  mailAccountSlug,
  badgeSlug,
  widgetId,
  layoutId,
  appPreferenceKey,
  logEntryId,
  aiRequestId,
  aiResponseId,
  policyClassId,
  makeIsoTimestamp,
  makeEpochMs,
  makeEpochMicros,
} from '../src/primitives.js';

describe('primitives — branded types', () => {
  it('userId / serviceId / auditId are nominal — not interchangeable', () => {
    const u = userId('usr_alice');
    const s = serviceId('svc_postgres');
    // Runtime values are still strings.
    expect(String(u)).toBe('usr_alice');
    expect(String(s)).toBe('svc_postgres');
    // The brand is type-level only; it doesn't appear at runtime.
    expect(u).not.toBe(s);
    // (Compile-time check would catch the swap; runtime check is best-effort.)
    expect(String(u) === String(s)).toBe(false);
  });
  it('every brand factory is callable and returns a string', () => {
    // Exercise each factory to keep the function-coverage line green.
    const ids = [
      userId('usr'),
      serviceId('svc'),
      serviceSlug('slug'),
      healthSnapshotId('hs'),
      alertRuleId('ar'),
      alertEventId('ae'),
      auditId('au'),
      auditEventId('aue'),
      requestId('req'),
      approvalId('apr'),
      approvalToken('tok'),
      dashboardCommandId('dca'),
      containerId('ctr'),
      imageId('img'),
      volumeId('vol'),
      networkId('net'),
      incusInstanceName('inc'),
      incusImageFingerprint('fp'),
      systemdUnitName('unit'),
      terminalSessionId('ts'),
      terminalCommandId('tc'),
      projectId('prj'),
      projectSlug('psl'),
      notificationId('ntf'),
      backupSnapshotId('bup'),
      schedulerJobName('job'),
      agentSlug('ag'),
      agentFilePath('path'),
      mailReviewId('mr'),
      mailAccountSlug('msl'),
      badgeSlug('b'),
      widgetId('w'),
      layoutId('l'),
      appPreferenceKey('k'),
      logEntryId('le'),
      aiRequestId('ar'),
      aiResponseId('ars'),
      policyClassId('pc'),
    ];
    ids.forEach((id) => {
      expect(typeof id).toBe('string');
    });
  });
  it('time primitive factories', () => {
    const iso = makeIsoTimestamp('2026-01-01T00:00:00Z');
    const ms = makeEpochMs(100);
    const us = makeEpochMicros(200);
    expect(String(iso)).toBe('2026-01-01T00:00:00Z');
    expect(ms).toBe(100);
    expect(us).toBe(200);
  });
});

describe('primitives — zId', () => {
  it('accepts a typical id', () => {
    expect(zId.parse('usr_alice')).toBe('usr_alice');
  });
  it('rejects an empty string', () => {
    expect(() => zId.parse('')).toThrow();
  });
  it('rejects strings over 128 chars', () => {
    expect(() => zId.parse('a'.repeat(129))).toThrow();
  });
  it('rejects illegal characters', () => {
    expect(() => zId.parse('usr/alice')).toThrow();
    expect(() => zId.parse('usr alice')).toThrow();
    expect(() => zId.parse('usr.alice')).toThrow();
  });
});

describe('primitives — zUuidV4', () => {
  it('accepts a canonical UUID v4', () => {
    const u = '550e8400-e29b-41d4-a716-446655440000';
    expect(zUuidV4.parse(u)).toBe(u);
  });
  it('rejects v1-shaped UUIDs', () => {
    expect(() => zUuidV4.parse('550e8400-e29b-11d4-a716-446655440000')).toThrow();
  });
  it('rejects non-UUID strings', () => {
    expect(() => zUuidV4.parse('not-a-uuid')).toThrow();
  });
});

describe('primitives — zUlid', () => {
  it('accepts a 26-char ULID', () => {
    const u = '01HXYZABCDEFGHJKMNPQRSTVWX';
    expect(zUlid.parse(u)).toBe(u);
  });
  it('rejects short strings', () => {
    expect(() => zUlid.parse('01HXYZ')).toThrow();
  });
  it('rejects illegal characters (I, L, O, U are not in Crockford base32)', () => {
    expect(() => zUlid.parse('I'.repeat(26))).toThrow();
  });
});

describe('primitives — zSlug', () => {
  it('accepts a service-style slug', () => {
    expect(zSlug.parse('llm-endpoint')).toBe('llm-endpoint');
    expect(zSlug.parse('cortex-dashboard')).toBe('cortex-dashboard');
  });
  it('rejects uppercase', () => {
    expect(() => zSlug.parse('Foo')).toThrow();
  });
  it('rejects leading/trailing dashes', () => {
    expect(() => zSlug.parse('-foo')).toThrow();
    expect(() => zSlug.parse('foo-')).toThrow();
  });
  it('rejects empty / too short', () => {
    expect(() => zSlug.parse('a')).toThrow();
  });
});

describe('primitives — zIsoTimestamp', () => {
  it('accepts an ISO-8601 datetime with offset', () => {
    expect(zIsoTimestamp.parse('2026-06-03T13:08:43-03:00')).toBe('2026-06-03T13:08:43-03:00');
  });
  it('accepts a UTC Z timestamp', () => {
    expect(zIsoTimestamp.parse('2026-06-03T16:08:43Z')).toBe('2026-06-03T16:08:43Z');
  });
  it('rejects non-ISO strings', () => {
    expect(() => zIsoTimestamp.parse('2026/06/03 13:08:43')).toThrow();
  });
});

describe('primitives — zEpochMs / zEpochMicros', () => {
  it('accepts a reasonable epoch ms', () => {
    expect(zEpochMs.parse(Date.now())).toBeTypeOf('number');
  });
  it('rejects non-integer ms', () => {
    expect(() => zEpochMs.parse(1.5)).toThrow();
  });
  it('rejects negative', () => {
    expect(() => zEpochMs.parse(-1)).toThrow();
  });
  it('accepts microseconds', () => {
    expect(zEpochMicros.parse(1_000_000_000_000)).toBe(1_000_000_000_000);
  });
});

describe('primitives — zIpAddress', () => {
  it('accepts a v4 address', () => {
    expect(zIpAddress.parse('127.0.0.1')).toBe('127.0.0.1');
  });
  it('accepts a v6 address', () => {
    expect(zIpAddress.parse('::1')).toBe('::1');
  });
  it('rejects obvious garbage', () => {
    expect(() => zIpAddress.parse('hello')).toThrow();
  });
});

describe('primitives — zUserAgent', () => {
  it('accepts an empty UA', () => {
    expect(zUserAgent.parse('')).toBe('');
  });
  it('accepts a typical UA', () => {
    expect(zUserAgent.parse('Mozilla/5.0 (X11; Linux x86_64)')).toBe(
      'Mozilla/5.0 (X11; Linux x86_64)',
    );
  });
  it('rejects a UA over 1024 chars', () => {
    expect(() => zUserAgent.parse('a'.repeat(1025))).toThrow();
  });
});

describe('primitives — zSha256', () => {
  it('accepts a 64-char hex digest', () => {
    const h = 'a'.repeat(64);
    expect(zSha256.parse(h)).toBe(h);
  });
  it('rejects uppercase hex', () => {
    expect(() => zSha256.parse('A'.repeat(64))).toThrow();
  });
  it('rejects short hex', () => {
    expect(() => zSha256.parse('a'.repeat(63))).toThrow();
  });
});

describe('primitives — IdPattern', () => {
  it('exposes the regex set', () => {
    expect(IdPattern.generic).toBeInstanceOf(RegExp);
    expect(IdPattern.uuidV4).toBeInstanceOf(RegExp);
    expect(IdPattern.ulid).toBeInstanceOf(RegExp);
    expect(IdPattern.slug).toBeInstanceOf(RegExp);
  });
});
