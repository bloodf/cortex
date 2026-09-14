/**
 * Mail Guardian repository.
 *
 * Reads from the mail_guardian_reviews and mail_guardian_actions tables
 * managed by packages/cortex-mail-guardian.
 */
import { and, asc, desc, eq, inArray, isNull, not, sql, type SQL } from "drizzle-orm";
import type { DbClient } from "../client";
import { mailGuardianReviews, mailGuardianActions, mailGuardianAccounts } from "../schema";
import type { MailGuardianReview, MailGuardianAction, MailGuardianAccount } from "../schema";

export interface ListMailReviewsOptions {
  accountSlug?: string;
  pendingOnly?: boolean;
  page?: number;
  pageSize?: number;
}

export interface PaginatedMailReviews {
  rows: MailGuardianReview[];
  total: number;
  page: number;
  pageSize: number;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;

export async function listMailReviews(
  db: DbClient,
  opts: ListMailReviewsOptions = {},
): Promise<PaginatedMailReviews> {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, opts.pageSize ?? DEFAULT_PAGE_SIZE));
  const offset = (page - 1) * pageSize;

  const conds: SQL[] = [];
  if (opts.accountSlug) conds.push(eq(mailGuardianReviews.accountSlug, opts.accountSlug));
  if (opts.pendingOnly) conds.push(isNull(mailGuardianReviews.resolvedAt));
  const where = conds.length > 0 ? and(...conds) : undefined;

  const [rows, totalRow] = await Promise.all([
    db
      .select()
      .from(mailGuardianReviews)
      .where(where)
      .orderBy(desc(mailGuardianReviews.requestedAt), desc(mailGuardianReviews.id))
      .limit(pageSize)
      .offset(offset),
    db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(mailGuardianReviews)
      .where(where),
  ]);

  return {
    rows,
    total: totalRow[0]?.count ?? 0,
    page,
    pageSize,
  };
}

export async function getMailReviewById(
  db: DbClient,
  id: number,
): Promise<MailGuardianReview | null> {
  const rows = await db
    .select()
    .from(mailGuardianReviews)
    .where(eq(mailGuardianReviews.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function listPendingActions(db: DbClient, limit = 20): Promise<MailGuardianAction[]> {
  return db
    .select()
    .from(mailGuardianActions)
    .where(eq(mailGuardianActions.status, "pending"))
    .orderBy(desc(mailGuardianActions.requestedAt), desc(mailGuardianActions.id))
    .limit(limit);
}

export async function getMailStats(db: DbClient): Promise<{
  total: number;
  pending: number;
  resolved: number;
  approved: number;
  flagged: number;
  highRisk: number;
  actionsPending: number;
}> {
  // Two round-trips: one conditional-aggregation over mail_guardian_reviews
  // (replaces 6 separate COUNT queries), plus one over mail_guardian_actions.
  const [reviewsRow, actionsRow] = await Promise.all([
    db
      .select({
        total: sql<number>`COUNT(*)::int`,
        pending: sql<number>`COUNT(*) FILTER (WHERE ${mailGuardianReviews.resolvedAt} IS NULL)::int`,
        resolved: sql<number>`COUNT(*) FILTER (WHERE ${mailGuardianReviews.resolvedAt} IS NOT NULL)::int`,
        approved: sql<number>`COUNT(*) FILTER (WHERE ${mailGuardianReviews.ownerDecision} = 'keep')::int`,
        flagged: sql<number>`COUNT(*) FILTER (WHERE ${mailGuardianReviews.ownerDecision} = 'spam')::int`,
        highRisk: sql<number>`COUNT(*) FILTER (WHERE ${mailGuardianReviews.modelVerdict} = 'spam')::int`,
      })
      .from(mailGuardianReviews),
    db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(mailGuardianActions)
      .where(eq(mailGuardianActions.status, "pending")),
  ]);

  return {
    total: reviewsRow[0]?.total ?? 0,
    pending: reviewsRow[0]?.pending ?? 0,
    resolved: reviewsRow[0]?.resolved ?? 0,
    approved: reviewsRow[0]?.approved ?? 0,
    flagged: reviewsRow[0]?.flagged ?? 0,
    highRisk: reviewsRow[0]?.highRisk ?? 0,
    actionsPending: actionsRow[0]?.count ?? 0,
  };
}

export async function updateMailReviewDecision(
  db: DbClient,
  id: number,
  decision: "keep" | "spam",
  approver: string,
): Promise<MailGuardianReview | null> {
  const res = await db
    .update(mailGuardianReviews)
    .set({
      ownerDecision: decision,
      approver,
      resolvedAt: new Date(),
    })
    .where(eq(mailGuardianReviews.id, id))
    .returning();
  return res[0] ?? null;
}

export async function createMailGuardianAction(
  db: DbClient,
  input: {
    reviewId: number;
    decision: "keep" | "spam";
    approver?: string;
    status?: "pending" | "processed" | "failed";
  },
): Promise<MailGuardianAction> {
  const inserted = await db
    .insert(mailGuardianActions)
    .values({
      reviewId: input.reviewId,
      decision: input.decision,
      approver: input.approver ?? "dashboard",
      status: input.status ?? "pending",
    })
    .returning();
  const row = inserted[0];
  if (!row) throw new Error("Failed to create mail guardian action");
  return row;
}

export async function batchUpdateMailReviewDecisions(
  db: DbClient,
  ids: number[],
  decision: "keep" | "spam",
  approver: string,
): Promise<number> {
  if (ids.length === 0) return 0;
  const updated = await db
    .update(mailGuardianReviews)
    .set({ ownerDecision: decision, approver, resolvedAt: new Date() })
    .where(inArray(mailGuardianReviews.id, ids))
    .returning({ id: mailGuardianReviews.id });
  return updated.length;
}

// ---------------------------------------------------------------------------
// Account management (mail_guardian_accounts)
//
// Monitored IMAP mailboxes. Passwords are stored base64-encoded for shell-safe
// parity with the MAIL_GUARDIAN_ACCOUNT_N_PASSWORD_B64 env vars; the backend
// loads these rows (DB precedence by slug) and decodes the password at runtime.
// ---------------------------------------------------------------------------

/** A monitored account with the base64 password redacted for client responses. */
export type MailGuardianAccountSafe = Omit<MailGuardianAccount, "passwordB64"> & {
  hasPassword: boolean;
};

export interface UpsertAccountInput {
  slug: string;
  address: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  /** Plaintext password; encoded to base64 before storage. Optional on update. */
  password?: string;
  inbox: string;
  trashMailbox?: string | null;
  reviewMailbox: string;
  enabled: boolean;
}

function toSafe(row: MailGuardianAccount): MailGuardianAccountSafe {
  const { passwordB64, ...rest } = row;
  return { ...rest, hasPassword: passwordB64.length > 0 };
}

export async function listMailAccounts(db: DbClient): Promise<MailGuardianAccountSafe[]> {
  const rows = await db.select().from(mailGuardianAccounts).orderBy(asc(mailGuardianAccounts.slug));
  return rows.map(toSafe);
}

export async function getMailAccountBySlug(
  db: DbClient,
  slug: string,
): Promise<MailGuardianAccount | null> {
  const rows = await db
    .select()
    .from(mailGuardianAccounts)
    .where(eq(mailGuardianAccounts.slug, slug))
    .limit(1);
  return rows[0] ?? null;
}

export async function createMailAccount(
  db: DbClient,
  input: UpsertAccountInput,
): Promise<MailGuardianAccountSafe> {
  if (!input.password) throw new Error("password is required when creating an account");
  const inserted = await db
    .insert(mailGuardianAccounts)
    .values({
      slug: input.slug,
      address: input.address,
      host: input.host,
      port: input.port,
      secure: input.secure,
      username: input.username,
      passwordB64: Buffer.from(input.password, "utf8").toString("base64"),
      inbox: input.inbox,
      trashMailbox: input.trashMailbox ?? null,
      reviewMailbox: input.reviewMailbox,
      enabled: input.enabled,
    })
    .returning();
  const row = inserted[0];
  if (!row) throw new Error("Failed to create mail account");
  return toSafe(row);
}

export async function updateMailAccount(
  db: DbClient,
  slug: string,
  input: UpsertAccountInput,
): Promise<MailGuardianAccountSafe | null> {
  const set: Partial<typeof mailGuardianAccounts.$inferInsert> = {
    address: input.address,
    host: input.host,
    port: input.port,
    secure: input.secure,
    username: input.username,
    inbox: input.inbox,
    trashMailbox: input.trashMailbox ?? null,
    reviewMailbox: input.reviewMailbox,
    enabled: input.enabled,
    updatedAt: new Date(),
  };
  // Only rotate the stored password when a new one is supplied.
  if (input.password) set.passwordB64 = Buffer.from(input.password, "utf8").toString("base64");
  const updated = await db
    .update(mailGuardianAccounts)
    .set(set)
    .where(eq(mailGuardianAccounts.slug, slug))
    .returning();
  return updated[0] ? toSafe(updated[0]) : null;
}

export async function setMailAccountEnabled(
  db: DbClient,
  slug: string,
  enabled: boolean,
): Promise<MailGuardianAccountSafe | null> {
  const updated = await db
    .update(mailGuardianAccounts)
    .set({ enabled, updatedAt: new Date() })
    .where(eq(mailGuardianAccounts.slug, slug))
    .returning();
  return updated[0] ? toSafe(updated[0]) : null;
}

export async function deleteMailAccount(db: DbClient, slug: string): Promise<boolean> {
  const deleted = await db
    .delete(mailGuardianAccounts)
    .where(eq(mailGuardianAccounts.slug, slug))
    .returning({ id: mailGuardianAccounts.id });
  return deleted.length > 0;
}
