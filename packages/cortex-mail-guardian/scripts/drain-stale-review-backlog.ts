/**
 * One-off maintenance: drain the stale pre-fix review backlog.
 *
 * Background: reviews generated before the 2026-06-15 MIME-decode fix could
 * contain raw MIME data rather than decoded text.
 * Because auto-quarantine requires BOTH the classify and the
 * verify pass to agree above threshold (see processor.ts `shouldAutoQuarantine`),
 * the garbage-era verify pass routinely disagreed/failed, so even high-confidence
 * spam fell through to the Review folder instead of auto-trashing. The result is
 * a large, stale operational backlog that no longer reflects anything actionable
 * (the messages are already out of the inbox, parked in the Review mailbox, and
 * many source messages have since been expunged).
 *
 * What this does: marks the trustworthy subset of that backlog
 *   resolved_at IS NULL
 *   AND requested_at < '2026-06-15'        (pre-fix / garbage era only)
 *   AND model_verdict = 'spam'
 *   AND model_confidence >= 0.82           (>= auto-quarantine threshold)
 * as resolved with owner_decision = 'spam', approver = 'backlog-drain'.
 *
 * What it deliberately does NOT do (and why):
 *   - It does NOT call applyReviewDecision / moveToTrash. Firing IMAP MOVEs
 *     on garbage-era messages whose UIDs have mostly been reassigned/expunged
 *     would error and churn for no benefit. The mail is already in the Review
 *     folder, out of the inbox.
 *   - It does NOT add 'block' sender rules. Garbage-era from_hash values are not
 *     trustworthy enough to drive permanent sender blocks.
 *   - It does NOT write the learning corpus (updateDecisionOutcome). Garbage-era
 *     decisions should not train the owner-preference brief.
 *   It is a pure, reversible DB queue-clear of known-bad-era spam reviews.
 *
 * It intentionally LEAVES untouched: every post-fix review (>= 2026-06-15), all
 * non-spam verdicts (not_spam / uncertain), and low-confidence (<0.82)
 * pre-fix spam rows — those still deserve a human glance.
 *
 * Safety:
 *   - DRY-RUN by default: prints the exact predicate, the matched count, and a
 *     sample. Performs NO writes.
 *   - With `--execute`: runs a single UPDATE in a transaction and prints the
 *     affected row count.
 *   - Reversible: every touched row carries approver = 'backlog-drain', so it
 *     can be undone with:
 *       UPDATE mail_guardian_reviews
 *         SET resolved_at = NULL, owner_decision = NULL, approver = NULL
 *       WHERE approver = 'backlog-drain';
 *
 * Credentials: DB creds come from DATABASE_URL / DB_* (supplied by
 * the protected dashboard.env). No IMAP / model creds needed.
 *
 * Run (dry-run):
 *   set -a; source "${CORTEX_SECRETS_DIR:-/etc/cortex/secrets}/dashboard.env"; set +a
 *   pnpm --filter @cortexos/mail-guardian exec tsx scripts/drain-stale-review-backlog.ts
 *
 * Run for real (after reviewing the dry-run):
 *   ... (same env) ...
 *   pnpm --filter @cortexos/mail-guardian exec tsx scripts/drain-stale-review-backlog.ts --execute
 */
import pg from 'pg';
import { loadConfig } from '../src/config.js';

const APPROVER = 'backlog-drain';
const PREDICATE = `resolved_at IS NULL
  AND requested_at < '2026-06-15'
  AND model_verdict = 'spam'
  AND model_confidence >= 0.82`;

async function main(): Promise<void> {
  const execute = process.argv.includes('--execute');
  // Reuse the package's own config loader (DB creds via the designated env
  // module) rather than reading process.env directly — mirrors store.ts.
  const config = loadConfig();
  const pool = config.databaseUrl
    ? new pg.Pool({ connectionString: config.databaseUrl })
    : new pg.Pool({
        host: config.db.host,
        port: config.db.port,
        database: config.db.database,
        user: config.db.user,
        password: config.db.password,
      });

  try {
    const { rows: countRows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text n FROM mail_guardian_reviews WHERE ${PREDICATE}`,
    );
    const matched = Number(countRows[0]?.n ?? 0);

    const { rows: sample } = await pool.query(
      `SELECT id, requested_at::date::text d, account_slug,
              round(model_confidence::numeric, 2) conf, left(coalesce(subject, ''), 60) subject
         FROM mail_guardian_reviews
        WHERE ${PREDICATE}
        ORDER BY requested_at LIMIT 10`,
    );

    process.stdout.write(`\nPredicate:\n  ${PREDICATE.replace(/\n\s*/g, '\n  ')}\n`);
    process.stdout.write(`\nMatched rows: ${matched}\n`);
    process.stdout.write(`Sample (first 10):\n`);
    sample.forEach((r) => {
      process.stdout.write(
        `  #${r.id}  ${r.d}  ${r.account_slug}  conf=${r.conf}  ${JSON.stringify(r.subject)}\n`,
      );
    });

    if (!execute) {
      process.stdout.write(
        `\nDRY-RUN — no writes. Re-run with --execute to resolve these ${matched} rows ` +
          `(owner_decision='spam', approver='${APPROVER}').\n`,
      );
      return;
    }

    await pool.query('BEGIN');
    const res = await pool.query(
      `UPDATE mail_guardian_reviews
          SET owner_decision = 'spam', approver = $1, resolved_at = now()
        WHERE ${PREDICATE}`,
      [APPROVER],
    );
    await pool.query('COMMIT');
    process.stdout.write(`\nEXECUTED — resolved ${res.rowCount} rows (approver='${APPROVER}').\n`);

    const { rows: remaining } = await pool.query<{ n: string }>(
      `SELECT count(*)::text n FROM mail_guardian_reviews WHERE resolved_at IS NULL`,
    );
    process.stdout.write(`Open reviews remaining: ${remaining[0]?.n}\n`);
  } catch (err) {
    await pool.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  process.stderr.write(`drain failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
