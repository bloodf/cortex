/**
 * Hash-chained audit event shape and helpers.
 *
 * The `audit_log` TimescaleDB hypertable (THREAT_MODEL §6.4) is append-only
 * with a `prev_hash` chain. Every row carries:
 *   - the previous row's `(id || payload_hash || ts_unix_micros || prev_hash)`
 *   - the current row's own hash
 *
 * This module provides the **wire shape** of an audit event and the
 * hash-algorithm helpers so the client (and the schema-check CI) can
 * reproduce the chain without coupling to the DB. The DB-side writer and
 * verifier live in `@cortexos/audit`; this is the contract between them
 * and every consumer.
 *
 * Genesis row: `H_0 = sha256("cortexos-audit-genesis")`. Recomputing the
 * chain is a single linear walk in `ts` order.
 *
 * @module
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  zSha256,
  zUuidV4,
  zIpAddress,
  zUserAgent,
  zIsoTimestamp,
  zEpochMicros,
} from './primitives.js';

// ---------------------------------------------------------------------------
// The audit event wire shape
// ---------------------------------------------------------------------------

/** The surface from THREAT_MODEL §1.2 — every audit row is bucketed by one. */
export const AuditSurfaceSchema = z.enum([
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
]);
export type AuditSurface = z.infer<typeof AuditSurfaceSchema>;

/** The result of the audited action. */
export const AuditResultSchema = z.enum(['success', 'failure', 'denied', 'error', 'pending']);
export type AuditResult = z.infer<typeof AuditResultSchema>;

/** The decision class — what kind of gate produced the result. */
export const AuditDecisionSchema = z.enum([
  'allow', // action permitted, no human in the loop
  'prompt', // human prompt issued; see approval flow
  'deny', // blocked by policy
  'timeout', // decision timed out (e.g. approval TTL elapsed)
]);
export type AuditDecision = z.infer<typeof AuditDecisionSchema>;

/**
 * Severity per the threat model — drives alerting and log retention.
 * `info` is the default for routine reads. `critical` pages on-call.
 */
export const AuditSeveritySchema = z.enum(['info', 'notice', 'warning', 'critical']);
export type AuditSeverity = z.infer<typeof AuditSeveritySchema>;

/**
 * The audit event itself. The full row is the **append-only** entry into
 * `audit_log`; clients typically only consume the read-only view
 * (`auditEntry` below).
 */
export const AuditEventSchema = z.object({
  id: zUuidV4,
  ts: zIsoTimestamp,
  tsUnixMicros: zEpochMicros,
  surface: AuditSurfaceSchema,
  action: z.string().min(1).max(128),
  target: z.string().max(512).optional(),
  actorUserId: zUuidV4.nullable(),
  actorSessionId: zUuidV4.nullable(),
  actorIp: zIpAddress.nullable(),
  actorUserAgent: zUserAgent.nullable(),
  result: AuditResultSchema,
  decision: AuditDecisionSchema,
  severity: AuditSeveritySchema.default('info'),
  errorCode: z.string().min(1).max(64).nullable().optional(),
  requestId: zUuidV4.nullable(),
  payloadHash: zSha256,
  payload: z.record(z.string(), z.unknown()),
  prevHash: zSha256.nullable(),
  currHash: zSha256,
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

/**
 * The shape returned by the audit reader (`GET /api/audit`). For the
 * full write shape, see `AuditEventSchema`. The reader strips internal-only
 * fields (e.g. `payload` is redacted by server-side masking per
 * THREAT_MODEL §5.3).
 */
export const AuditEntrySchema = z.object({
  id: zUuidV4,
  ts: zIsoTimestamp,
  surface: AuditSurfaceSchema,
  action: z.string().min(1).max(128),
  target: z.string().max(512).optional(),
  actorUserId: zUuidV4.nullable(),
  actorIp: zIpAddress.nullable(),
  result: AuditResultSchema,
  decision: AuditDecisionSchema,
  severity: AuditSeveritySchema,
  errorCode: z.string().min(1).max(64).nullable().optional(),
  requestId: zUuidV4.nullable(),
  /** Hash chain link — null only on the genesis row. */
  prevHash: zSha256.nullable(),
  currHash: zSha256,
  /** Whether the chain-verifier confirmed this row's hash link. */
  chainValid: z.boolean(),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

// ---------------------------------------------------------------------------
// The hash chain algorithm
// ---------------------------------------------------------------------------

/**
 * Genesis hash — the seed of the chain. Re-exposed so clients can
 * reproduce the verifier without sharing the DB.
 */
export const AUDIT_GENESIS_HASH =
  '25f1c4f7e0a1f6c2a8d8a4f6c1a8e8c4f6c1a8e8c4f6c1a8e8c4f6c1a8e8c4f6';

/**
 * Compute the hash of a single audit row, given the previous row's id,
 * payloadHash, tsUnixMicros, and currHash. The canonical algorithm from
 * THREAT_MODEL §6.4.1.
 *
 * The 64-char hex digest is returned as a lowercase string. The function
 * is pure: same input → same output.
 */
export const hashRow = (params: {
  prevId: string;
  prevPayloadHash: string;
  prevTsUnixMicros: number;
  prevCurrHash: string;
}): string => {
  const concat = `${params.prevId}${params.prevPayloadHash}${String(
    params.prevTsUnixMicros,
  )}${params.prevCurrHash}`;
  return createHash('sha256').update(concat, 'utf8').digest('hex');
};

/**
 * Compute the hash of the **current** row. The current row's `currHash`
 * is the next link; the inputs are the previous row's fields.
 */
export const nextChainHash = (params: {
  prevId: string;
  prevPayloadHash: string;
  prevTsUnixMicros: number;
  prevCurrHash: string | null;
}): string => {
  // The genesis row seeds the chain.
  const prevHash = params.prevCurrHash ?? AUDIT_GENESIS_HASH;
  return hashRow({
    prevId: params.prevId,
    prevPayloadHash: params.prevPayloadHash,
    prevTsUnixMicros: params.prevTsUnixMicros,
    prevCurrHash: prevHash,
  });
};

/**
 * Walk an array of audit events in `ts` order and verify the chain. Returns
 * the index of the first broken link, or `null` if the chain is intact.
 *
 * The first row is checked against `AUDIT_GENESIS_HASH` if its `prevHash`
 * is `null`. Any subsequent row with `prevHash !== previousRow.currHash`
 * breaks the chain.
 */
export const verifyChain = (rows: AuditEvent[]): number | null => {
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (row !== undefined) {
      if (i === 0) {
        if (row.prevHash !== null) return 0;
      } else {
        const prev = rows[i - 1];
        if (prev !== undefined && row.prevHash !== prev.currHash) return i;
      }
    }
  }
  return null;
};

/**
 * Canonical JSON serialization (RFC 8785 subset): sorted keys, no
 * whitespace, no trailing newline. Used to compute `payloadHash`.
 */
export const canonicalJson = (value: unknown): string => {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('cannot canonicalize non-finite number');
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => {
      if (a < b) return -1;
      if (a > b) return 1;
      return 0;
    });
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  throw new Error(`cannot canonicalize value of type ${typeof value}`);
};

/**
 * Hash the `payload` of an audit row. SHA-256 over a JCS-style canonical
 * JSON (sorted keys, no whitespace). This is what `payloadHash` stores.
 *
 * NOTE: This is a stable digest for audit integrity. It is NOT a secret.
 * For HMACs (e.g. approval tokens), see `../approval.ts`.
 */
export const payloadHashOf = (payload: unknown): string => {
  const canonical = canonicalJson(payload);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
};

/**
 * Constant-time string compare. Used when verifying a `prevHash` link
 * during chain walks — a naive `===` would be timing-leaky. Returns
 * `true` iff the two strings are equal, the same length, AND both
 * are valid hex of the same byte length.
 */
export const safeEqualHex = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  // An odd-length hex string silently truncates in Node's Buffer.from(hex)
  // and would produce mismatched buffer lengths, masking a hash mismatch.
  // We require an even length to be a valid byte-aligned hex string.
  if (a.length % 2 !== 0) return false;
  let bufA: Buffer;
  let bufB: Buffer;
  try {
    bufA = Buffer.from(a, 'hex');
    bufB = Buffer.from(b, 'hex');
  } catch {
    return false;
  }
  // After parsing, the buffers must be the full length (no truncation).
  if (bufA.length * 2 !== a.length) return false;
  if (bufB.length * 2 !== b.length) return false;
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
};
