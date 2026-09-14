/**
 * Mail Guardian — server functions (WP-15).
 *
 * Transport is createServerFn RPC, NOT REST (see docs/rebuild/ADR-001). Each
 * function is a top-level `createServerFn(...).middleware([gate]).handler(
 * serverFnNoop)` literal; the gate (`defineServerFn`) carries auth/RBAC/CSRF/
 * rate-limit/approval/audit + the business handler. All server-only logic
 * (db repos, schema) is imported DYNAMICALLY inside each handler so
 * import-protection never sees `@/server/**` in the client bundle.
 *
 * Ported behavior from the legacy SvelteKit handlers:
 *   packages/dashboard/src/routes/api/mail-guardian/accounts/+server.ts          (list/create)
 *   packages/dashboard/src/routes/api/mail-guardian/accounts/[slug]/+server.ts   (update/toggle/delete)
 *   packages/dashboard/src/routes/api/mail-guardian/[id]/flag/+server.ts         (flag)
 *   packages/dashboard/src/routes/api/mail-guardian/[id]/approve/+server.ts      (approve)
 *   packages/dashboard/src/routes/api/mail-guardian/batch/+server.ts             (batch)
 *
 * Frontend (Wave 2) calls these typed:
 *   await listAccounts()
 *   await listReviews({ data: { accountSlug, pendingOnly, page, pageSize } })
 *   await flagReview({ data: { id } })
 *   await approveReview({ data: { id } })
 *   await batchDecision({ data: { ids, action } })
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { defineServerFn, serverFnNoop } from "@/lib/api/define-server-fn";

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const AccountCreateInput = z
  .object({
    slug: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9-]*$/, "slug must be lowercase alphanumeric with dashes"),
    address: z.string().trim().email().max(255),
    host: z.string().trim().min(1).max(255),
    port: z.number().int().min(1).max(65535).default(993),
    secure: z.boolean().default(true),
    username: z.string().trim().min(1).max(255),
    password: z.string().min(1).max(1024),
    inbox: z.string().trim().min(1).max(255).default("INBOX"),
    trashMailbox: z.string().trim().max(255).optional().nullable(),
    reviewMailbox: z.string().trim().min(1).max(255).default("INBOX.Cortex Mail Guardian Review"),
    enabled: z.boolean().default(true),
  })
  .strict();

const AccountUpdateInput = z
  .object({
    slug: z.string().trim().min(1).max(64),
    address: z.string().trim().email().max(255),
    host: z.string().trim().min(1).max(255),
    port: z.number().int().min(1).max(65535).default(993),
    secure: z.boolean().default(true),
    username: z.string().trim().min(1).max(255),
    /** Optional on update — omit to keep the stored password. */
    password: z.string().min(1).max(1024).optional(),
    inbox: z.string().trim().min(1).max(255).default("INBOX"),
    trashMailbox: z.string().trim().max(255).optional().nullable(),
    reviewMailbox: z.string().trim().min(1).max(255).default("INBOX.Cortex Mail Guardian Review"),
    enabled: z.boolean().default(true),
  })
  .strict();

const AccountDeleteInput = z.object({ slug: z.string().trim().min(1).max(64) }).strict();

const ReviewListInput = z
  .object({
    accountSlug: z.string().min(1).max(64).optional(),
    pendingOnly: z.coerce.boolean().optional(),
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(1).max(500).optional(),
  })
  .strict();

const ReviewIdInput = z.object({ id: z.coerce.number().int().positive() }).strict();

const BatchInput = z
  .object({
    ids: z.array(z.number().int().positive()).min(1).max(500),
    action: z.enum(["approve", "flag"]),
  })
  .strict();

// ---------------------------------------------------------------------------
// listAccounts — GET, auth: admin → { accounts: MailGuardianAccountSafe[] }
// ---------------------------------------------------------------------------

const listAccountsGate = defineServerFn({
  method: "GET",
  auth: "admin",
  input: z.object({}).strict(),
  surface: "mail-guardian",
  action: "mail-guardian.accounts.list",
  handler: async () => {
    const { getDb } = await import("@/server/db/client");
    const { listMailAccounts } = await import("@/server/db/repos/mail_guardian");
    const accounts = await listMailAccounts(getDb());
    return { accounts };
  },
});
export const listAccounts = createServerFn({ method: "GET" })
  .middleware([listAccountsGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
// createAccount — POST, auth: admin → { account: MailGuardianAccountSafe }
// ---------------------------------------------------------------------------

const createAccountGate = defineServerFn({
  method: "POST",
  auth: "admin",
  input: AccountCreateInput,
  surface: "mail-guardian",
  action: "mail-guardian.accounts.create",
  target: (input) => input.slug,
  rateLimit: { limit: 30, windowSec: 60, bucket: "user" },
  handler: async ({ input }) => {
    const { getDb } = await import("@/server/db/client");
    const { getMailAccountBySlug, createMailAccount } =
      await import("@/server/db/repos/mail_guardian");
    const { validationError } = await import("@/server/errors/types");
    const db = getDb();
    const existing = await getMailAccountBySlug(db, input.slug);
    if (existing) {
      throw validationError(`An account with slug "${input.slug}" already exists`, [
        { field: "slug", message: "must be unique" },
      ]);
    }
    const account = await createMailAccount(db, input);
    return { account };
  },
});
export const createAccount = createServerFn({ method: "POST" })
  .middleware([createAccountGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
// updateAccount — POST, auth: admin → { account: MailGuardianAccountSafe } | 404
// ---------------------------------------------------------------------------

const updateAccountGate = defineServerFn({
  method: "POST",
  auth: "admin",
  input: AccountUpdateInput,
  surface: "mail-guardian",
  action: "mail-guardian.accounts.update",
  target: (input) => input.slug,
  rateLimit: { limit: 30, windowSec: 60, bucket: "user" },
  handler: async ({ input }) => {
    const { getDb } = await import("@/server/db/client");
    const { updateMailAccount } = await import("@/server/db/repos/mail_guardian");
    const { notFoundError } = await import("@/server/errors/types");
    const { slug, ...rest } = input;
    const account = await updateMailAccount(getDb(), slug, { ...rest, slug });
    if (!account) throw notFoundError(`Account "${slug}" not found`, "mail_account");
    return { account };
  },
});
export const updateAccount = createServerFn({ method: "POST" })
  .middleware([updateAccountGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
// deleteAccount — POST, auth: admin → { ok: true, slug } | 404
// ---------------------------------------------------------------------------

const deleteAccountGate = defineServerFn({
  method: "POST",
  auth: "admin",
  input: AccountDeleteInput,
  surface: "mail-guardian",
  action: "mail-guardian.accounts.delete",
  target: (input) => input.slug,
  rateLimit: { limit: 30, windowSec: 60, bucket: "user" },
  handler: async ({ input }) => {
    const { getDb } = await import("@/server/db/client");
    const { deleteMailAccount } = await import("@/server/db/repos/mail_guardian");
    const { notFoundError } = await import("@/server/errors/types");
    const deleted = await deleteMailAccount(getDb(), input.slug);
    if (!deleted) throw notFoundError(`Account "${input.slug}" not found`, "mail_account");
    return { ok: true, slug: input.slug } as const;
  },
});
export const deleteAccount = createServerFn({ method: "POST" })
  .middleware([deleteAccountGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
// listReviews — GET, auth: any → { reviews, total, page, pageSize }
// ---------------------------------------------------------------------------

const listReviewsGate = defineServerFn({
  method: "GET",
  auth: "any",
  input: ReviewListInput,
  surface: "mail-guardian",
  action: "mail-guardian.reviews.list",
  handler: async ({ input }) => {
    const { getDb } = await import("@/server/db/client");
    const { listMailReviews } = await import("@/server/db/repos/mail_guardian");
    const result = await listMailReviews(getDb(), {
      accountSlug: input.accountSlug,
      pendingOnly: input.pendingOnly ?? false,
      page: input.page,
      pageSize: input.pageSize,
    });
    return {
      reviews: result.rows,
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    };
  },
});
export const listReviews = createServerFn({ method: "GET" })
  .middleware([listReviewsGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
// flagReview — POST, auth: admin → { id, ownerDecision, resolvedAt, approver } | 404
// Sets ownerDecision='spam' and creates a pending mail_guardian_actions row.
// ---------------------------------------------------------------------------

const flagReviewGate = defineServerFn({
  method: "POST",
  auth: "admin",
  input: ReviewIdInput,
  surface: "mail-guardian",
  action: "mail-guardian.flag",
  target: (input) => String(input.id),
  rateLimit: { limit: 60, windowSec: 60, bucket: "user" },
  handler: async ({ input }) => {
    const { getDb } = await import("@/server/db/client");
    const { getMailReviewById, updateMailReviewDecision, createMailGuardianAction } =
      await import("@/server/db/repos/mail_guardian");
    const { notFoundError } = await import("@/server/errors/types");
    const db = getDb();
    const review = await getMailReviewById(db, input.id);
    if (!review) throw notFoundError(`Review ${input.id} not found`, "mail_review");
    const updated = await updateMailReviewDecision(db, input.id, "spam", "dashboard");
    if (!updated) throw notFoundError(`Review ${input.id} not found`, "mail_review");
    await createMailGuardianAction(db, {
      reviewId: input.id,
      decision: "spam",
      approver: "dashboard",
      status: "pending",
    });
    return {
      id: updated.id,
      ownerDecision: updated.ownerDecision,
      resolvedAt: updated.resolvedAt,
      approver: updated.approver,
    };
  },
});
export const flagReview = createServerFn({ method: "POST" })
  .middleware([flagReviewGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
// approveReview — POST, auth: admin → { id, ownerDecision, resolvedAt, approver } | 404
// Sets ownerDecision='keep' and creates a pending mail_guardian_actions row.
// ---------------------------------------------------------------------------

const approveReviewGate = defineServerFn({
  method: "POST",
  auth: "admin",
  input: ReviewIdInput,
  surface: "mail-guardian",
  action: "mail-guardian.approve",
  target: (input) => String(input.id),
  rateLimit: { limit: 60, windowSec: 60, bucket: "user" },
  handler: async ({ input }) => {
    const { getDb } = await import("@/server/db/client");
    const { getMailReviewById, updateMailReviewDecision, createMailGuardianAction } =
      await import("@/server/db/repos/mail_guardian");
    const { notFoundError } = await import("@/server/errors/types");
    const db = getDb();
    const review = await getMailReviewById(db, input.id);
    if (!review) throw notFoundError(`Review ${input.id} not found`, "mail_review");
    const updated = await updateMailReviewDecision(db, input.id, "keep", "dashboard");
    if (!updated) throw notFoundError(`Review ${input.id} not found`, "mail_review");
    await createMailGuardianAction(db, {
      reviewId: input.id,
      decision: "keep",
      approver: "dashboard",
      status: "pending",
    });
    return {
      id: updated.id,
      ownerDecision: updated.ownerDecision,
      resolvedAt: updated.resolvedAt,
      approver: updated.approver,
    };
  },
});
export const approveReview = createServerFn({ method: "POST" })
  .middleware([approveReviewGate])
  .handler(serverFnNoop);

// ---------------------------------------------------------------------------
// batch — POST, auth: admin → { updated: number, action }
// Batch approve or flag mail reviews.
// ---------------------------------------------------------------------------

const batchGate = defineServerFn({
  method: "POST",
  auth: "admin",
  input: BatchInput,
  surface: "mail-guardian",
  action: "mail-guardian.batch",
  target: (input) => `${input.action}:${input.ids.length}`,
  rateLimit: { limit: 30, windowSec: 60, bucket: "user" },
  handler: async ({ input }) => {
    const { getDb } = await import("@/server/db/client");
    const { batchUpdateMailReviewDecisions, createMailGuardianAction } =
      await import("@/server/db/repos/mail_guardian");
    const db = getDb();
    const decision = input.action === "approve" ? "keep" : "spam";
    const updated = await batchUpdateMailReviewDecisions(db, input.ids, decision, "dashboard");
    await Promise.all(
      input.ids.map((id) =>
        createMailGuardianAction(db, {
          reviewId: id,
          decision,
          approver: "dashboard",
          status: "pending",
        }),
      ),
    );
    return { updated, action: input.action };
  },
});
export const batch = createServerFn({ method: "POST" })
  .middleware([batchGate])
  .handler(serverFnNoop);
