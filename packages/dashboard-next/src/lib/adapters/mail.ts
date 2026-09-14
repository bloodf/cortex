/**
 * Adapter: MailGuardianReview DB row → sys-pilot MailReview mock shape.
 *
 * The real DB stores hashes (fromHash, subjectHash, bodyHash) to protect PII;
 * plaintext is never persisted. We derive display-friendly values from the
 * available fields:
 *   from     ← accountSlug + truncated fromHash
 *   subject  ← summary (the model-generated summary stored in the row)
 *   snippet  ← first 120 chars of summary
 *   body     ← summary (full — no plaintext body available)
 *   risk     ← derived from modelVerdict + modelConfidence
 *   status   ← derived from ownerDecision + resolvedAt
 *   received_at ← requestedAt
 *
 * Functions are pure — no side-effects, no API calls.
 */
import type { MailReview as MockMailReview } from "@/mocks/types";

/**
 * Server-side MailGuardianReview row shape returned by listReviews.
 * Mirrors the DB schema (mail_guardian_reviews) — hashes only, no plaintext.
 */
export interface ServerMailReview {
  id: number;
  accountSlug: string;
  messageUid: number;
  messageId: string | null;
  fromHash: string;
  domainHash: string;
  subjectHash: string;
  bodyHash: string;
  summary: string;
  subject?: string | null;
  bodyText?: string | null;
  /** Rich HTML body (text/html MIME part); null for plain-text mails. */
  bodyHtml?: string | null;
  modelVerdict: string;
  modelConfidence: string;
  spamScore: number | null;
  category: string | null;
  senderLegitimacy: string | null;
  sourceMailbox: string;
  ownerDecision: string | null;
  approver: string | null;
  requestedAt: Date | string;
  resolvedAt: Date | string | null;
}

/**
 * Server-side MailGuardianAccount (safe — password redacted).
 */
export interface ServerMailAccount {
  id: number;
  slug: string;
  address: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  hasPassword: boolean;
  inbox: string;
  trashMailbox: string | null;
  reviewMailbox: string;
  enabled: boolean;
  createdAt: Date | string;
  updatedAt: Date | string;
}

/** Derive review urgency from AI spam score, not assessment confidence. */
function toRisk(spamScore: number | null): MockMailReview["risk"] {
  if (spamScore === null || !Number.isFinite(spamScore)) return "medium";
  if (spamScore >= 80) return "high";
  if (spamScore >= 30) return "medium";
  return "low";
}

/** Derive display status from ownerDecision + resolvedAt. */
function toStatus(
  ownerDecision: string | null,
  resolvedAt: Date | string | null,
): MockMailReview["status"] {
  if (!resolvedAt) return "pending";
  if (ownerDecision === "spam") return "flagged";
  if (ownerDecision === "keep") return "approved";
  return "pending";
}

/**
 * Map a server MailGuardianReview row to the mock MailReview shape that
 * sys-pilot components consume.
 */
export function toMailReviewRow(m: ServerMailReview): MockMailReview {
  // Coerce every string-shaped field defensively: the DB contract types claim
  // `string`, but a malformed/legacy row can carry null/number. A bare
  // `.slice`/`.trim` on a non-string throws, and React Query swallows the
  // rejection → the WHOLE mail page renders blank with no console error.
  const summary = String(m.summary ?? "").trim() || "(no summary)";
  const subject = String(m.subject ?? "").trim() || summary;
  const body = String(m.bodyText ?? "").trim() || summary;
  const bodyHtml = typeof m.bodyHtml === "string" && m.bodyHtml.trim() ? m.bodyHtml : "";
  const snippet = body.length > 120 ? `${body.slice(0, 117)}…` : body;
  const fromHash = String(m.fromHash ?? "");
  const fromDisplay = `${m.accountSlug}/<${fromHash.slice(0, 8)}…>`;
  return {
    id: String(m.id),
    from: fromDisplay,
    subject,
    snippet,
    body,
    bodyHtml,
    spamScore: m.spamScore,
    category: m.category,
    senderLegitimacy: m.senderLegitimacy,
    classificationState: m.spamScore === null || !m.category ? "failed" : "scored",
    risk: toRisk(m.spamScore),
    status: toStatus(m.ownerDecision, m.resolvedAt),
    received_at:
      m.requestedAt instanceof Date ? m.requestedAt.toISOString() : String(m.requestedAt),
  };
}

export type { MockMailReview };
