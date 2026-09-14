/**
 * One-off maintenance: re-decode the display fields of historical
 * mail_guardian_reviews rows.
 *
 * Background: before the decode fix, the processor stored the raw
 * MIME/base64/quoted-printable body in `summary` (and ran the spam classifier
 * on that garbage). This script re-fetches each row's original message from its
 * account's review mailbox over IMAP (READ-ONLY), re-parses it through the same
 * path that now yields `message.bodyText`/`message.subject`, re-runs
 * `redactEmail` to get a clean `summary`, and UPDATEs `subject` / `body_text` /
 * `summary` on the review row.
 *
 * Safety:
 *   - DRY-RUN by default: prints old vs new (truncated) per row + a summary
 *     count. Performs NO writes.
 *   - With `--execute`: applies the UPDATEs inside a single transaction.
 *     Idempotent (re-running yields the same decoded values) and UPDATE-only —
 *     it never INSERTs or DELETEs review rows, and never moves/deletes mail.
 *   - `--only-undecoded` (default true): skip rows whose summary already looks
 *     decoded. Pass `--all` to reconsider every row.
 *   - `--limit N`: cap the number of rows processed (useful for a first pass).
 *
 * Credentials: reuses the package's own config. DB creds come from
 * DATABASE_URL / DB_* (supplied by the protected dashboard.env); IMAP account
 * creds come from MAIL_GUARDIAN_ACCOUNT_*_* (protected mail-guardian.env) and/or
 * the mail_guardian_accounts table — merged exactly like src/index.ts buildDeps.
 *
 * Run (dry-run, reads real DB + IMAP if creds are present):
 *   set -a; \
 *     source "${CORTEX_SECRETS_DIR:-/etc/cortex/secrets}/dashboard.env"; \
 *     source "${CORTEX_SECRETS_DIR:-/etc/cortex/secrets}/mail-guardian.env"; \
 *     set +a
 *   pnpm --filter @cortexos/mail-guardian exec \
 *     tsx scripts/backfill-review-decode.ts
 *
 * Run for real (operator only, after reviewing the dry-run):
 *   ... (same env) ...
 *   pnpm --filter @cortexos/mail-guardian exec \
 *     tsx scripts/backfill-review-decode.ts --execute
 */
import { accountFromRow, loadConfig, mergeAccounts } from '../src/config.js';
import type { MailAccountConfig } from '../src/config.js';
import { TlsImapMailClient } from '../src/imap.js';
import { redactEmail } from '../src/redact.js';
import runSequentially from '../src/sequential.js';
import { GuardianStore } from '../src/store.js';
import type { BackfillReviewRow } from '../src/store.js';

interface Options {
  execute: boolean;
  onlyUndecoded: boolean;
  limit?: number;
}

function parseArgs(argv: string[]): Options {
  const execute = argv.includes('--execute');
  const all = argv.includes('--all');
  const limitFlag = argv.findIndex((a) => a === '--limit');
  const limit = limitFlag >= 0 && argv[limitFlag + 1] ? Number(argv[limitFlag + 1]) : undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    throw new Error('--limit must be a positive integer');
  }
  return { execute, onlyUndecoded: !all, limit };
}

/** Heuristic: does this stored summary still look like undecoded MIME? */
function looksUndecoded(row: BackfillReviewRow): boolean {
  const haystack = `${row.summary ?? ''}\n${row.body_text ?? ''}`;
  return (
    haystack.includes('=C3=') ||
    haystack.includes('=E2=') ||
    /Content-Transfer-Encoding/i.test(haystack) ||
    /Content-Type:\s*(text|multipart)/i.test(haystack) ||
    /boundary=/i.test(haystack) ||
    // A long unbroken base64-ish run with no spaces is almost certainly an
    // undecoded body, not a human summary.
    /[A-Za-z0-9+/]{120,}/.test(haystack) ||
    row.body_text === null ||
    row.summary === null
  );
}

function truncate(value: string | null | undefined, max = 120): string {
  const text = (value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

interface ReviewUpdate {
  id: number;
  subject?: string;
  bodyText?: string;
  summary: string;
}

type RowOutcome =
  | { kind: 'change'; update: ReviewUpdate }
  | { kind: 'unchanged' }
  | { kind: 'notFound' }
  | { kind: 'noCreds' }
  | { kind: 'error' };

/**
 * Re-decode a single review row: fetch its original message from the account's
 * review mailbox (READ-ONLY), re-parse + re-redact, and report whether the
 * decoded fields differ. Performs no DB writes — it only computes the patch.
 */
async function processRow(
  row: BackfillReviewRow,
  accountBySlug: Map<string, MailAccountConfig>,
  mail: TlsImapMailClient,
  missingAccounts: Set<string>,
): Promise<RowOutcome> {
  const account = accountBySlug.get(row.account_slug);
  if (!account) {
    missingAccounts.add(row.account_slug);
    return { kind: 'noCreds' };
  }

  // The stored message_uid is the original INBOX UID. IMAP MOVE/COPY reassigns
  // UIDs in the destination mailbox, so that UID does not address the message in
  // the review mailbox (servers either miss or reject it as an invalid uidset).
  // The immutable Message-ID header is the reliable key, so prefer it; fall back
  // to the raw UID only for the rare row with no stored Message-ID.
  let message;
  try {
    message = row.message_id
      ? await mail.fetchByMessageId(account, account.reviewMailbox, row.message_id)
      : await mail.fetchRawByUid(account, account.reviewMailbox, row.message_uid);
  } catch (error) {
    // Transient connection / IMAP errors: skip this row, keep going.
    process.stderr.write(
      `[backfill] id=${row.id} ${row.account_slug}:${row.message_uid} fetch error: ` +
        `${error instanceof Error ? error.message : String(error)}\n`,
    );
    return { kind: 'error' };
  }

  if (!message) {
    process.stdout.write(
      `[backfill] id=${row.id} ${row.account_slug}:${row.message_uid} not found in review mailbox (skip)\n`,
    );
    return { kind: 'notFound' };
  }

  const decodedBody = message.bodyText ?? message.text;
  const redacted = redactEmail({
    from: message.from,
    subject: message.subject,
    text: decodedBody,
  });

  const subjectChanged = (row.subject ?? '') !== message.subject;
  const bodyChanged = (row.body_text ?? '') !== decodedBody;
  const summaryChanged = (row.summary ?? '') !== redacted.summary;
  if (!subjectChanged && !bodyChanged && !summaryChanged) {
    return { kind: 'unchanged' };
  }

  process.stdout.write(
    `[backfill] id=${row.id} ${row.account_slug}:${row.message_uid}\n` +
      `    old summary: ${truncate(row.summary)}\n` +
      `    new summary: ${truncate(redacted.summary)}\n`,
  );

  return {
    kind: 'change',
    update: {
      id: row.id,
      subject: message.subject || undefined,
      bodyText: decodedBody || undefined,
      summary: redacted.summary,
    },
  };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const config = loadConfig();

  const store = new GuardianStore(config);
  const mail = new TlsImapMailClient();

  // Merge DB-backed accounts with env accounts, exactly like index.ts buildDeps,
  // so each review row's account_slug resolves to real IMAP credentials.
  await store.ensureSchema();
  const dbAccounts = (await store.listAccounts()).map(accountFromRow);
  const accounts = mergeAccounts(config.accounts, dbAccounts);
  const accountBySlug = new Map<string, MailAccountConfig>(accounts.map((a) => [a.slug, a]));

  const rows = await store.listReviewsForBackfill();
  const candidates = rows.filter((row) => (opts.onlyUndecoded ? looksUndecoded(row) : true));
  const selected = opts.limit ? candidates.slice(0, opts.limit) : candidates;

  process.stdout.write(
    `[backfill] mode=${opts.execute ? 'EXECUTE' : 'DRY-RUN'} ` +
      `rows=${rows.length} candidates=${candidates.length} selected=${selected.length} ` +
      `filter=${opts.onlyUndecoded ? 'undecoded-only' : 'all'}\n`,
  );

  const missingAccounts = new Set<string>();

  // Process rows sequentially (one IMAP connection per account, reused across
  // FETCHes). Each row yields a tagged outcome; counts are aggregated after.
  const outcomes = await runSequentially(selected, (row) =>
    processRow(row, accountBySlug, mail, missingAccounts),
  );

  await mail.close().catch(() => undefined);

  const updates = outcomes
    .filter((o): o is Extract<RowOutcome, { kind: 'change' }> => o.kind === 'change')
    .map((o) => o.update);
  const wouldChange = updates.length;
  const unchanged = outcomes.filter((o) => o.kind === 'unchanged').length;
  const notFound = outcomes.filter((o) => o.kind === 'notFound').length;
  const noCreds = outcomes.filter((o) => o.kind === 'noCreds').length;
  const errors = outcomes.filter((o) => o.kind === 'error').length;

  if (opts.execute && updates.length > 0) {
    const applied = await store.updateReviewDecodedFieldsBatch(updates);
    process.stdout.write(`[backfill] EXECUTED ${applied} updates (committed)\n`);
  }

  process.stdout.write(
    `[backfill] summary: wouldChange=${wouldChange} unchanged=${unchanged} ` +
      `notFound=${notFound} noCreds=${noCreds} errors=${errors}` +
      `${opts.execute ? ` applied=${updates.length}` : ' (dry-run, no writes)'}\n`,
  );
  if (missingAccounts.size > 0) {
    process.stderr.write(
      `[backfill] WARNING: no credentials for accounts: ${[...missingAccounts].join(', ')}\n`,
    );
  }

  await store.close();
}

main().catch((error) => {
  process.stderr.write(
    `backfill-review-decode: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
