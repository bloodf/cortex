/**
 * Approval flow: HMAC-SHA256, action-hash-bound, single-use, short-TTL
 * confirmation tokens for destructive and privileged operations.
 *
 * Threat-model anchor: THREAT_MODEL §3 ("Required Approval Flows") and
 * SR-020 / SR-021 / SR-060 / SR-062 / SR-071 / SR-072 / SR-120.
 *
 * Wire flow:
 *   1. Client computes the action's stable hash (`actionHashOf`).
 *   2. Client issues `POST /api/approvals/request` with `{ actionHash, phrase }`.
 *   3. Server: verifies admin role, verifies phrase, mints an `ApprovalToken`
 *      bound to the hash + the caller's `sessionId` (server-derived — never
 *      client-supplied, per `deriveCortexSessionId` in the existing app).
 *      Stores `(token, claims, expiresAt)` in the in-memory `Map` (v1; DB in
 *      v1.1 per D-01). Audit row `approval_requested`.
 *   4. Server returns `{ token, expiresAt }` (token in plain text for the
 *      client to use as a one-shot bearer; the audit row stores its hash).
 *   5. Client issues the destructive action with `X-Cortex-Approval-Token`.
 *   6. Server: `verifyApprovalToken(token, actionHash, sessionId)`. On
 *      success, the token is removed from the store (single-use) and a
 *      5-second grace timer starts; the UI can cancel during the grace.
 *   7. Audit rows: `approval_consumed` + `action_started` + (later)
 *      `action_completed` / `action_failed`.
 *
 * Token claims (per THREAT_MODEL §3.5):
 *   - `action_hash` (sha256 hex, 64 chars)
 *   - `session_id` (server-derived, hex)
 *   - `user_id` (uuid v4)
 *   - `iat` (issued-at, unix seconds)
 *   - `exp` (expires-at, unix seconds)
 *   - `nonce` (16 bytes hex — single-use discriminator)
 *   - `class` ("destructive" | "privileged" | "reveal" | "write")
 *
 * The token is the HMAC-SHA256 of the canonical claim string with the
 * server-side `CORTEX_CONFIRMATION_HMAC_SECRET`. The first 8 chars of the
 * secret are NEVER used as input here; the secret is the key.
 *
 * @module
 */
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { zSha256, zUuidV4, type SessionId, type UserId, type AuditId } from './primitives.js';
import { canonicalJson } from './audit.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default TTL for destructive-class tokens. 60s per THREAT_MODEL §3.5. */
export const APPROVAL_TTL_DESTRUCTIVE_SEC = 60;

/** TTL for reveal-class tokens. 300s per THREAT_MODEL §3.5. */
export const APPROVAL_TTL_REVEAL_SEC = 300;

/** TTL for write-class tokens (env-browser). Same as destructive. */
export const APPROVAL_TTL_WRITE_SEC = 60;

/** TTL for privileged-class tokens (e.g. system admin action). */
export const APPROVAL_TTL_PRIVILEGED_SEC = 60;

/** Grace period (in seconds) between token consumption and action exec. */
export const APPROVAL_GRACE_SEC = 5;

/** Allowed clock skew between client and server when validating `exp`. */
export const APPROVAL_CLOCK_SKEW_SEC = 5;

// ---------------------------------------------------------------------------
// Action class
// ---------------------------------------------------------------------------

export const ApprovalClassSchema = z.enum(['destructive', 'privileged', 'reveal', 'write']);
export type ApprovalClass = z.infer<typeof ApprovalClassSchema>;

export const ttlForClass = (cls: ApprovalClass): number => {
  switch (cls) {
    case 'destructive':
      return APPROVAL_TTL_DESTRUCTIVE_SEC;
    case 'privileged':
      return APPROVAL_TTL_PRIVILEGED_SEC;
    case 'reveal':
      return APPROVAL_TTL_REVEAL_SEC;
    case 'write':
      return APPROVAL_TTL_WRITE_SEC;
    default:
      return APPROVAL_TTL_DESTRUCTIVE_SEC;
  }
};

// ---------------------------------------------------------------------------
// Action hash
// ---------------------------------------------------------------------------

/**
 * Compute the stable, server-trusted action hash. The input is the
 * canonicalized action descriptor (string or object). The output is the
 * lowercase 64-char hex SHA-256 digest.
 *
 * Examples:
 *   actionHashOf("systemd.restart:cortex-dashboard")
 *   actionHashOf({ tool: "docker.action", args: { action: "start", name: "grafana" } })
 *
 * The server MUST compute the hash from its own view of the action, not
 * the client's `actionHash` field directly. The client sends the
 * descriptor; the server hashes and uses the hash to look up the policy
 * entry.
 */
export const actionHashOf = (descriptor: unknown): string => {
  const canonical = canonicalJson(descriptor);
  return createHmac('sha256', 'cortexos-action-hash').update(canonical, 'utf8').digest('hex');
};

// ---------------------------------------------------------------------------
// Token claims
// ---------------------------------------------------------------------------

/**
 * The structured claims embedded in a `ApprovalToken`. The HMAC is computed
 * over the canonical JSON of these claims; the signature is the token's
 * value (alongside an encoded prefix).
 */
export const ApprovalClaimsSchema = z.object({
  actionHash: zSha256,
  sessionId: z.string().min(1).max(128),
  userId: zUuidV4,
  iat: z.number().int().min(0).max(4_102_444_800), // through 2100
  exp: z.number().int().min(0).max(4_102_444_800),
  nonce: z.string().regex(/^[0-9a-f]{16,64}$/),
  class: ApprovalClassSchema,
});
export type ApprovalClaims = z.infer<typeof ApprovalClaimsSchema>;

// ---------------------------------------------------------------------------
// Token wire format
// ---------------------------------------------------------------------------

/**
 * The opaque token string. Format: `<b64url-claims>.<b64url-sig>` where
 * `sig` is the HMAC-SHA256 of the b64url-claims bytes. Total length is
 * bounded by the claim sizes; in practice it lands at ~200 chars.
 */
export const ApprovalTokenSchema = z
  .string()
  .min(64)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, 'invalid token wire format');
export type ApprovalTokenWire = z.infer<typeof ApprovalTokenSchema>;

/** The token request from the client. */
export const ApprovalRequestPayloadSchema = z.object({
  actionHash: zSha256,
  phrase: z.string().min(1).max(256),
  class: ApprovalClassSchema,
  /** Optional human-readable description (logged, not bound into the hash). */
  description: z.string().max(500).optional(),
});
export type ApprovalRequestPayload = z.infer<typeof ApprovalRequestPayloadSchema>;

/** The response from `POST /api/approvals/request`. */
export const ApprovalResponseSchema = z.object({
  token: ApprovalTokenSchema,
  expiresAt: z.string().datetime({ offset: true }),
  /** Echo of the action hash for the client to confirm binding. */
  actionHash: zSha256,
  /** Echo of the class for UI rendering. */
  class: ApprovalClassSchema,
  /** Grace period in seconds (always 5 per THREAT_MODEL §3.5). */
  graceSec: z.literal(5),
});
export type ApprovalResponse = z.infer<typeof ApprovalResponseSchema>;

/** The HTTP header carrying the token. */
export const APPROVAL_TOKEN_HEADER = 'x-cortex-approval-token';

// ---------------------------------------------------------------------------
// Issued-token record (server-side)
// ---------------------------------------------------------------------------

/**
 * The server's in-memory record for a minted token. The wire format is
 * `(token, expiresAt, claims)`. The token is removed from the store on
 * first valid use (single-use, SR-121).
 *
 * `consumedAt` is set on first successful `verifyApprovalToken` call.
 * `canceled` is set if the user cancels during the grace period.
 */
export interface IssuedApproval {
  readonly token: ApprovalTokenWire;
  readonly claims: ApprovalClaims;
  readonly expiresAt: Date;
  readonly issuedAt: Date;
  /** Audit row id for `approval_requested` — links the request to the row. */
  readonly auditId: AuditId | null;
  /** Set on first valid use. */
  consumedAt: Date | null;
  /** Set if the user cancels during the 5s grace. */
  canceled: boolean;
}

// ---------------------------------------------------------------------------
// Internals — token sign/parse
// ---------------------------------------------------------------------------

/** Base64-URL-encode a Buffer. Pure helper, no padding. */
const base64UrlEncode = (buf: Buffer): string => buf.toString('base64url');

/**
 * Build the wire token from claims + secret. The signature is HMAC-SHA256
 * of the b64url-encoded claims string.
 */
const signToken = (claims: ApprovalClaims, secret: string): ApprovalTokenWire => {
  const claimsJson = canonicalJson(claims);
  const claimsB64 = base64UrlEncode(Buffer.from(claimsJson, 'utf8'));
  const sig = createHmac('sha256', secret).update(claimsB64, 'utf8').digest('base64url');
  return `${claimsB64}.${sig}`;
};

/**
 * Parse and verify a token. Returns the claims on success, `null` on
 * malformed or bad-signature. Does NOT check action binding, expiry, or
 * consumed-state — those are checked by `verifyApprovalToken`.
 */
const parseToken = (token: ApprovalTokenWire, secret: string): ApprovalClaims | null => {
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const claimsB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  const expectedSig = createHmac('sha256', secret).update(claimsB64, 'utf8').digest();
  let actualSig: Buffer;
  try {
    actualSig = Buffer.from(sigB64, 'base64url');
  } catch {
    return null;
  }
  if (actualSig.length !== expectedSig.length) return null;
  if (!timingSafeEqual(actualSig, expectedSig)) return null;
  let claimsJson: string;
  try {
    claimsJson = Buffer.from(claimsB64, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(claimsJson);
  } catch {
    return null;
  }
  const result = ApprovalClaimsSchema.safeParse(parsed);
  if (!result.success) return null;
  return result.data;
};

// ---------------------------------------------------------------------------
// Mint + verify
// ---------------------------------------------------------------------------

/**
 * Mint an `ApprovalToken` for the given action. The `secret` is the
 * server-only `CORTEX_CONFIRMATION_HMAC_SECRET`; never log it, never
 * expose it. The `sessionId` MUST be server-derived (e.g. via
 * `deriveCortexSessionId` in the existing app), never client-supplied.
 *
 * The function is pure: same input → same token. Do not store the secret
 * in process memory longer than necessary; pass it in as a parameter.
 */
export const issueApprovalToken = (params: {
  actionHash: string;
  sessionId: SessionId;
  userId: UserId;
  class: ApprovalClass;
  secret: string;
  /** Override the default TTL. Optional. */
  ttlSec?: number;
  /** Override the clock (for tests). Optional. */
  now?: Date;
}): { token: ApprovalTokenWire; claims: ApprovalClaims; expiresAt: Date } => {
  const now = params.now ?? new Date();
  const ttl = params.ttlSec ?? ttlForClass(params.class);
  const iat = Math.floor(now.getTime() / 1000);
  const exp = iat + ttl;
  const nonce = randomBytes(16).toString('hex');
  const claims: ApprovalClaims = {
    actionHash: params.actionHash,
    sessionId: params.sessionId,
    userId: params.userId,
    iat,
    exp,
    nonce,
    class: params.class,
  };
  const token = signToken(claims, params.secret);
  return { token, claims, expiresAt: new Date(exp * 1000) };
};

/**
 * Verify a token. Returns the parsed claims if the token is valid, not
 * expired, and not yet consumed. Returns `null` for any failure. The
 * `consumed` callback is called **exactly once** on the first valid
 * verification — the caller uses this to mark the in-memory record as
 * consumed.
 */
export const verifyApprovalToken = (params: {
  token: ApprovalTokenWire;
  expectedActionHash: string;
  expectedSessionId: SessionId;
  secret: string;
  now?: Date;
  /** Returns true if the token is still in the in-memory store. */
  isLive: (nonce: string) => boolean;
  /** Marks the token as consumed. Called exactly once per valid token. */
  markConsumed: (nonce: string) => void;
}): ApprovalClaims | null => {
  const now = params.now ?? new Date();
  const claims = parseToken(params.token, params.secret);
  if (!claims) return null;
  if (claims.actionHash !== params.expectedActionHash) return null;
  if (claims.sessionId !== params.expectedSessionId) return null;
  const nowSec = Math.floor(now.getTime() / 1000);
  if (nowSec > claims.exp + APPROVAL_CLOCK_SKEW_SEC) return null;
  if (nowSec < claims.iat - APPROVAL_CLOCK_SKEW_SEC) return null;
  if (!params.isLive(claims.nonce)) return null;
  // Single-use: mark consumed exactly here. The caller is responsible
  // for making `isLive` return false on the next call.
  params.markConsumed(claims.nonce);
  return claims;
};
