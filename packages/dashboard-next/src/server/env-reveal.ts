/**
 * env-browser reveal grants — PAM-gated, time-bounded secret reveal.
 *
 * THREAT_MODEL §1.2 surface 8 intent: the env-browser MAY reveal the
 * plaintext value of a secret, but ONLY after the operator re-proves
 * their identity with their PAM password. A successful unlock opens a
 * short reveal window (default 10 minutes) bound to the operator's
 * session; while the window is open, GET /api/env-browser returns raw
 * values. When it lapses, the API falls back to masked-only.
 *
 * Storage: in-memory Map<sessionId, expiresAtMs> — the dashboard runs
 * as a single Node process, so this matches the approval-store pattern
 * in `approval/index.ts`. Grants do not survive a restart (fail-safe:
 * a restart re-locks every session).
 */

/** Reveal window length. 10 minutes per the operator-facing contract. */
export const REVEAL_TTL_MS = 10 * 60 * 1000;
export const REVEAL_TTL_SEC = REVEAL_TTL_MS / 1000;

/** sessionId → epoch-ms at which the reveal window expires. */
const grants = new Map<string, number>();

/**
 * Open (or extend) a reveal window for a session. Returns the new
 * expiry timestamp (epoch ms).
 */
export function grantReveal(sessionId: string): number {
  const expiresAt = Date.now() + REVEAL_TTL_MS;
  grants.set(sessionId, expiresAt);
  return expiresAt;
}

/**
 * Is there a live reveal window for this session? Expired grants are
 * evicted lazily on read.
 */
export function hasRevealGrant(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false;
  const expiresAt = grants.get(sessionId);
  if (expiresAt === undefined) return false;
  if (expiresAt <= Date.now()) {
    grants.delete(sessionId);
    return false;
  }
  return true;
}

/** Remaining reveal window expiry (epoch ms) or null when locked. */
export function revealExpiresAt(sessionId: string | null | undefined): number | null {
  if (!sessionId) return null;
  const expiresAt = grants.get(sessionId);
  if (expiresAt === undefined || expiresAt <= Date.now()) return null;
  return expiresAt;
}

/** Explicitly close a session's reveal window (e.g. on logout). */
export function revokeReveal(sessionId: string | null | undefined): void {
  if (sessionId) grants.delete(sessionId);
}

/** Test helper: drop every grant. */
export function resetRevealGrants(): void {
  grants.clear();
}
