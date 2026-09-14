/**
 * Adapter tests for `toMailReviewRow` (MP-028 / item 1.2, "hashId class").
 *
 * Feeds REAL DB-shaped rows — integer serial `id`, NULL/non-string hashes,
 * `Date` objects, missing optional subject/bodyText — and asserts the mapper
 * never throws and produces sane output. A throw here would reject the whole
 * mail query and blank the page (React Query swallows the rejection).
 */

import { describe, it, expect } from "vitest";
import { toMailReviewRow, type ServerMailReview } from "../mail";

function baseRow(overrides: Partial<ServerMailReview> = {}): ServerMailReview {
  return {
    id: 359,
    accountSlug: "personal",
    messageUid: 1234,
    messageId: "<abc@example.com>",
    fromHash: "deadbeefcafef00d",
    domainHash: "0011223344556677",
    subjectHash: "aabbccddeeff0011",
    bodyHash: "1122334455667788",
    summary: "A short model summary of the message.",
    subject: "Real subject line",
    bodyText: "Decoded plaintext body.",
    modelVerdict: "ham",
    modelConfidence: "0.42",
    spamScore: 7,
    category: "transactional",
    senderLegitimacy: "legitimate",
    sourceMailbox: "inbox",
    ownerDecision: null,
    approver: null,
    requestedAt: new Date("2026-06-15T12:00:00.000Z"),
    resolvedAt: null,
    ...overrides,
  };
}

describe("toMailReviewRow — DB-shaped rows", () => {
  it("maps a normal row with a Date requestedAt to an ISO string", () => {
    const row = toMailReviewRow(baseRow());
    expect(row.id).toBe("359"); // integer serial id → string id
    expect(row.from).toBe("personal/<deadbeef…>");
    expect(row.subject).toBe("Real subject line");
    expect(row.body).toBe("Decoded plaintext body.");
    expect(row.received_at).toBe("2026-06-15T12:00:00.000Z");
    expect(row.status).toBe("pending");
  });

  it("maps AI spam score and classification metadata without using confidence as risk", () => {
    const row = toMailReviewRow(
      baseRow({ spamScore: 73, category: "suspicious", senderLegitimacy: "unknown" }),
    );
    expect(row.spamScore).toBe(73);
    expect(row.category).toBe("suspicious");
    expect(row.classificationState).toBe("scored");
    expect(row.risk).toBe("medium");
  });

  it("distinguishes classification failure from clean low-score mail", () => {
    const row = toMailReviewRow(
      baseRow({ spamScore: null, category: null, senderLegitimacy: null }),
    );
    expect(row.classificationState).toBe("failed");
    expect(row.spamScore).toBeNull();
  });

  it("a NULL fromHash does not throw and yields an empty hash slice", () => {
    const row = toMailReviewRow(baseRow({ fromHash: null as unknown as string }));
    expect(row.from).toBe("personal/<…>");
  });

  it("a numeric fromHash (non-string) is coerced and does not throw", () => {
    const row = toMailReviewRow(baseRow({ fromHash: 12345678 as unknown as string }));
    expect(row.from).toBe("personal/<12345678…>");
  });

  it("missing subject + bodyText fall back to the summary", () => {
    const row = toMailReviewRow(
      baseRow({ subject: null, bodyText: null, summary: "Only summary here." }),
    );
    expect(row.subject).toBe("Only summary here.");
    expect(row.body).toBe("Only summary here.");
    expect(row.snippet).toBe("Only summary here.");
  });

  it("a NULL summary falls back to the placeholder without throwing", () => {
    const row = toMailReviewRow(
      baseRow({
        summary: null as unknown as string,
        subject: null,
        bodyText: null,
      }),
    );
    expect(row.subject).toBe("(no summary)");
    expect(row.body).toBe("(no summary)");
  });

  it("a string requestedAt passes through unchanged", () => {
    const row = toMailReviewRow(baseRow({ requestedAt: "2026-01-01T00:00:00.000Z" }));
    expect(row.received_at).toBe("2026-01-01T00:00:00.000Z");
  });

  it("truncates a long body into a 120-char snippet with ellipsis", () => {
    const longBody = "x".repeat(300);
    const row = toMailReviewRow(baseRow({ bodyText: longBody }));
    expect(row.snippet.length).toBe(118); // 117 chars + ellipsis
    expect(row.snippet.endsWith("…")).toBe(true);
  });

  it("derives high risk from spam score, not confidence", () => {
    const row = toMailReviewRow(
      baseRow({ modelVerdict: "spam", modelConfidence: "0.30", spamScore: 99 }),
    );
    expect(row.risk).toBe("high");
  });

  it("derives status flagged/approved from ownerDecision + resolvedAt", () => {
    const resolvedAt = new Date("2026-06-15T13:00:00.000Z");
    expect(toMailReviewRow(baseRow({ ownerDecision: "spam", resolvedAt })).status).toBe("flagged");
    expect(toMailReviewRow(baseRow({ ownerDecision: "keep", resolvedAt })).status).toBe("approved");
  });
});
