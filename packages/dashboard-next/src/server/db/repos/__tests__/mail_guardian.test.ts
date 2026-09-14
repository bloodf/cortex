// @vitest-environment node
/**
 * Mail Guardian repository tests.
 *
 * Covers:
 *   PERF-01: getMailStats returns correct shape/values via the new single
 *            conditional-aggregation query (2 round-trips instead of 7).
 *   PERF-02: batchUpdateMailReviewDecisions updates all ids in one call
 *            (verified by outcome — all rows resolved, return count correct).
 *
 * NOTE: The drizzle schema for mail_guardian_reviews includes `subject` and
 * `body_text` columns that have not yet been captured in a SQL migration.
 * Drizzle includes ALL schema columns in INSERT statements, so any drizzle
 * `.insert(mailGuardianReviews)` fails in the PGlite test DB (missing columns).
 * We work around this by seeding rows via raw SQL on the PGlite client, which
 * only specifies the columns that exist in the applied migrations. This is a
 * pre-existing schema/migration gap — not introduced by these fixes.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { createTestDb, type PgliteDbClient } from "../../test-utils";
import { mailGuardianReviews } from "../../schema";
import { getMailStats, batchUpdateMailReviewDecisions } from "../mail_guardian";

let db: PgliteDbClient;
let client: PGlite;

/**
 * Insert a minimal mail_guardian_reviews row via raw SQL (bypasses drizzle's
 * full-column INSERT which references columns not yet in the SQL migrations).
 * Returns the inserted id.
 */
async function insertReview(
  pg: PGlite,
  opts: {
    messageUid: number;
    modelVerdict?: string;
    ownerDecision?: string | null;
    approver?: string | null;
    resolvedAt?: string | null;
  },
): Promise<number> {
  const verdict = opts.modelVerdict ?? "ham";
  const decision = opts.ownerDecision ?? null;
  const approver = opts.approver ?? null;
  const resolvedAt = opts.resolvedAt ?? null;
  const res = await pg.query<{ id: number }>(
    `INSERT INTO mail_guardian_reviews
       (account_slug, message_uid, from_hash, domain_hash, subject_hash, body_hash,
        summary, model_verdict, model_confidence, owner_decision, approver, resolved_at)
     VALUES ('test', $1, 'fh', 'dh', 'sh', 'bh', 'test summary', $2, 0.9, $3, $4, $5)
     RETURNING id`,
    [opts.messageUid, verdict, decision, approver, resolvedAt],
  );
  return res.rows[0].id;
}

/**
 * Insert a mail_guardian_actions row via raw SQL.
 * The decision CHECK only allows: spam, keep, block_sender, allow_sender.
 */
async function insertAction(pg: PGlite, reviewId: number, status: string): Promise<void> {
  await pg.query(
    `INSERT INTO mail_guardian_actions (review_id, decision, status)
     VALUES ($1, 'keep', $2)`,
    [reviewId, status],
  );
}

beforeEach(async () => {
  const r = await createTestDb();
  db = r.db;
  client = r.client;
}, 30_000);

afterEach(async () => {
  if (client) await client.close();
});

describe("getMailStats (PERF-01)", () => {
  it("returns zeroes on empty table", async () => {
    const stats = await getMailStats(db);
    expect(stats).toEqual({
      total: 0,
      pending: 0,
      resolved: 0,
      approved: 0,
      flagged: 0,
      highRisk: 0,
      actionsPending: 0,
    });
  });

  it("counts reviews correctly across all stat buckets", async () => {
    // row1: pending (no resolvedAt), ham verdict
    const id1 = await insertReview(client, { messageUid: 1 });
    // row2: resolved + approved (ownerDecision = 'keep'), ham verdict
    const id2 = await insertReview(client, {
      messageUid: 2,
      ownerDecision: "keep",
      approver: "admin",
      resolvedAt: new Date().toISOString(),
    });
    // row3: resolved + flagged (ownerDecision = 'spam'), ham verdict
    await insertReview(client, {
      messageUid: 3,
      ownerDecision: "spam",
      approver: "admin",
      resolvedAt: new Date().toISOString(),
    });
    // row4: pending, spam verdict (highRisk)
    await insertReview(client, { messageUid: 4, modelVerdict: "spam" });

    // One pending action — counts toward actionsPending
    await insertAction(client, id1, "pending");
    // One non-pending action — should NOT count
    await insertAction(client, id2, "done");

    const stats = await getMailStats(db);

    expect(stats.total).toBe(4);
    expect(stats.pending).toBe(2); // row1 + row4 have no resolvedAt
    expect(stats.resolved).toBe(2); // row2 + row3
    expect(stats.approved).toBe(1); // row2 (ownerDecision = 'keep')
    expect(stats.flagged).toBe(1); // row3 (ownerDecision = 'spam')
    expect(stats.highRisk).toBe(1); // row4 (modelVerdict = 'spam')
    expect(stats.actionsPending).toBe(1); // only the 'pending' action
  });
});

describe("batchUpdateMailReviewDecisions (PERF-02)", () => {
  it("returns 0 and does nothing for empty ids array", async () => {
    const count = await batchUpdateMailReviewDecisions(db, [], "keep", "admin");
    expect(count).toBe(0);
  });

  it("updates all provided ids in one call and returns correct count", async () => {
    const ids = await Promise.all([
      insertReview(client, { messageUid: 10 }),
      insertReview(client, { messageUid: 11 }),
      insertReview(client, { messageUid: 12 }),
    ]);
    expect(ids).toHaveLength(3);

    const count = await batchUpdateMailReviewDecisions(db, ids, "spam", "tester");
    expect(count).toBe(3);

    // Verify every row was actually updated via drizzle SELECT
    const rows = await db
      .select({
        ownerDecision: mailGuardianReviews.ownerDecision,
        approver: mailGuardianReviews.approver,
        resolvedAt: mailGuardianReviews.resolvedAt,
      })
      .from(mailGuardianReviews)
      .where(eq(mailGuardianReviews.approver, "tester"));

    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.ownerDecision).toBe("spam");
      expect(row.approver).toBe("tester");
      expect(row.resolvedAt).not.toBeNull();
    }
  });

  it("only updates the specified subset of ids", async () => {
    const ids = await Promise.all([
      insertReview(client, { messageUid: 20 }),
      insertReview(client, { messageUid: 21 }),
      insertReview(client, { messageUid: 22 }),
    ]);

    // Only update first two
    const count = await batchUpdateMailReviewDecisions(
      db,
      ids.slice(0, 2),
      "keep",
      "partial-tester",
    );
    expect(count).toBe(2);

    // Third row should still have no ownerDecision
    const untouched = await db
      .select({ ownerDecision: mailGuardianReviews.ownerDecision })
      .from(mailGuardianReviews)
      .where(eq(mailGuardianReviews.id, ids[2]));
    expect(untouched[0]?.ownerDecision).toBeNull();
  });
});
