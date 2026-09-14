/**
 * Audit hook — append-only event log with HMAC chain (THREAT_MODEL §6).
 *
 * M1 implementation: in-memory ring buffer keyed by append order. The chain
 * math matches the real DB-backed `audit_log` hypertable.
 *
 * Algorithm (THREAT_MODEL §6.4.1):
 *
 *   R_0 (the first row) has prev_hash = null.
 *   The genesis running-hash is sha256("cortexos-audit-genesis").
 *
 *   For row R_n (n >= 1):
 *     prev_hash = sha256(
 *       R_{n-1}.id ||
 *       R_{n-1}.payload_hash ||
 *       R_{n-1}.ts_unix_micros ||
 *       running_hash_at_R_{n-1}
 *     )
 *
 * Verification walks the chain and recomputes each prev_hash. A mismatch
 * at any row invalidates that row and all subsequent rows (per §6.4).
 *
 * M3 swaps the in-memory store for a real DB. The `audit()` contract is
 * the same; only the persistence is different.
 *
 * Public API:
 *   - audit(input) → append an event, returns the persisted row
 *   - listAudit() → return the chain (most recent last)
 *   - verifyAuditChain() → walk the chain; returns { ok, length } on
 *     success or { ok: false, index, reason } on first failure
 *   - resetAudit() → test helper (clears events + running hash)
 */

import { createHash, randomUUID } from "node:crypto";
import type { AuditEvent, SessionId, UserId } from "../entities";
import { sha256Hex } from "../crypto";
import { asAuditEventId } from "../entities";

const GENESIS_LITERAL = "cortexos-audit-genesis";
const GENESIS_HASH = createHash("sha256").update(GENESIS_LITERAL).digest("hex");

// ---------------------------------------------------------------------------
// Store + running-hash state
// ---------------------------------------------------------------------------

const events: AuditEvent[] = [];
let runningHash: string = GENESIS_HASH;

/** Test helper: drop all events and reset the running hash. */
export function resetAudit(): void {
  events.length = 0;
  runningHash = GENESIS_HASH;
}

/** Return the chain (most recent last). Read-only. */
export function listAudit(): readonly AuditEvent[] {
  return events;
}

/** Test helper: number of events. */
export function auditSize(): number {
  return events.length;
}

/** Test helper: current running hash. */
export function runningHashForTests(): string {
  return runningHash;
}

// ---------------------------------------------------------------------------
// Hash math
// ---------------------------------------------------------------------------

function payloadHash(payload: Record<string, unknown>): string {
  // Stable JSON serialization — keys sorted alphabetically.
  const sorted = JSON.stringify(payload, Object.keys(payload).sort());
  return sha256Hex(sorted);
}

function tsUnixMicros(iso: string): string {
  return String(new Date(iso).getTime() * 1000);
}

/**
 * Compute the next running hash by chaining the row's identity + payload +
 * timestamp + the prior running hash.
 */
function advanceRunningHash(
  row: { id: string; payloadHash: string; createdAt: string },
  prevRunningHash: string,
): string {
  return sha256Hex(
    `${row.id}::${row.payloadHash}::${tsUnixMicros(row.createdAt)}::${prevRunningHash}`,
  );
}

// ---------------------------------------------------------------------------
// Append
// ---------------------------------------------------------------------------

export interface AuditInput {
  actorUserId: UserId | null;
  actorSessionId: SessionId | null;
  actorIp: string | null;
  actorUserAgent: string | null;
  surface: string;
  action: string;
  target: string | null;
  result: AuditEvent["result"];
  errorCode: string | null;
  /** Correlates with the HTTP request. */
  requestId?: string;
  /** Already-redacted payload (caller's responsibility per SR-025). */
  payload: Record<string, unknown>;
}

/**
 * Append a new audit event. Computes the HMAC chain link and returns the
 * persisted row.
 */
export function audit(input: AuditInput): AuditEvent {
  const now = new Date().toISOString();
  const id = asAuditEventId(randomUUID());
  const ph = payloadHash(input.payload);
  const requestId = input.requestId ?? randomUUID();

  const isFirst = events.length === 0;
  const prevHash = isFirst ? null : runningHash;

  const row: AuditEvent = {
    id,
    actorUserId: input.actorUserId,
    actorSessionId: input.actorSessionId,
    actorIp: input.actorIp,
    actorUserAgent: input.actorUserAgent,
    surface: input.surface,
    action: input.action,
    target: input.target,
    result: input.result,
    errorCode: input.errorCode,
    requestId,
    prevHash,
    payloadHash: ph,
    payload: input.payload,
    createdAt: now,
  };
  events.push(row);

  // Advance the running hash for the next insert.
  runningHash = advanceRunningHash(row, runningHash);

  return row;
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

export type AuditVerifyResult =
  { ok: true; length: number } | { ok: false; index: number; reason: string };

/**
 * Walk the chain and verify each row's prev_hash matches the expected
 * running hash. Returns the first failure if any.
 */
export function verifyAuditChain(): AuditVerifyResult {
  let h = GENESIS_HASH;
  for (let i = 0; i < events.length; i++) {
    const row = events[i];
    if (i === 0) {
      if (row.prevHash !== null) {
        return {
          ok: false,
          index: i,
          reason: `row 0 prevHash must be null, got ${row.prevHash}`,
        };
      }
    } else if (row.prevHash !== h) {
      return {
        ok: false,
        index: i,
        reason: `prevHash mismatch at index ${i}: expected ${h}, got ${row.prevHash ?? "null"}`,
      };
    }
    h = advanceRunningHash(row, h);
  }
  return { ok: true, length: events.length };
}

/** Exposed for tests — compute the expected running hash AFTER index `i`. */
export function expectedRunningHashAt(i: number): string {
  if (i < 0 || i >= events.length) {
    throw new Error(`Index out of range: ${i}`);
  }
  let hh = GENESIS_HASH;
  for (let j = 0; j <= i; j++) {
    hh = advanceRunningHash(events[j], hh);
  }
  return hh;
}
