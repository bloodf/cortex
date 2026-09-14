import pg from 'pg';
import type { GuardianConfig } from './config.js';
import type { RuleMatch } from './rules.js';
import runSequentially from './sequential.js';
import { isMailGuardianSchemaManaged } from './env.js';

export interface PendingReviewInput {
  accountSlug: string;
  messageUid: number;
  messageId?: string;
  fromHash: string;
  domainHash: string;
  subjectHash: string;
  bodyHash: string;
  summary: string;
  /** Plaintext subject for the dashboard review detail (display only). */
  subject?: string;
  /** Decoded, human-readable body for the dashboard review detail. */
  body?: string;
  /**
   * Raw decoded text/html part (nothing stripped). Persisted as `body_html`
   * so the dashboard can render rich HTML after client-side sanitization.
   */
  bodyHtml?: string;
  modelVerdict: string;
  modelConfidence: number;
  spamScore: number;
  category: string;
  senderLegitimacy: string;
  sourceMailbox: string;
}

export interface ReviewRecord {
  id: number;
  account_slug: string;
  message_uid: number;
  message_id?: string | null;
  from_hash: string;
  domain_hash: string;
  source_mailbox: string;
}

export interface BackfillReviewRow {
  id: number;
  account_slug: string;
  message_uid: number;
  message_id: string | null;
  subject: string | null;
  body_text: string | null;
  summary: string | null;
}

export interface OpenReviewRow {
  id: number;
  account_slug: string;
  message_uid: number;
  message_id: string | null;
  from_hash: string;
  domain_hash: string;
  source_mailbox: 'inbox' | 'review';
}

export interface DecisionInput {
  accountSlug: string;
  messageUid: number;
  fromHash: string;
  domainHash: string;
  summary: string;
  model: string | null;
  verdict: string | null;
  confidence: number | null;
  reasons: string[];
  riskSignals: string[];
  verifyModel: string | null;
  verifyVerdict: string | null;
  verifyConfidence: number | null;
  spamScore: number | null;
  category: string | null;
  senderLegitimacy: string | null;
  verifySpamScore: number | null;
  verifyCategory: string | null;
  verifySenderLegitimacy: string | null;
  outcome: string;
}

export interface DecisionRow {
  account_slug: string;
  message_uid: number;
  from_hash: string;
  domain_hash: string;
  summary: string;
  verdict: string | null;
  outcome: string;
  created_at: Date;
}

export interface KnowledgeBriefRow {
  id: number;
  brief: string;
  source_decisions: number;
  generated_at: Date;
}

export interface QueuedReviewDecision {
  id: number;
  review_id: number;
  decision: 'spam' | 'keep' | 'block_sender' | 'allow_sender';
  approver: string;
}

export interface AccountRow {
  slug: string;
  address: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password_b64: string;
  inbox: string;
  trash_mailbox: string | null;
  review_mailbox: string;
  enabled: boolean;
}

export class GuardianStore {
  private readonly pool: pg.Pool;

  constructor(config: GuardianConfig) {
    this.pool = config.databaseUrl
      ? new pg.Pool({ connectionString: config.databaseUrl })
      : new pg.Pool({
          host: config.db.host,
          port: config.db.port,
          database: config.db.database,
          user: config.db.user,
          password: config.db.password,
        });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async ensureSchema(): Promise<void> {
    if (isMailGuardianSchemaManaged()) {
      // The installer owns DDL. Resolve required tables/columns with no row reads;
      // missing migrations or runtime grants fail startup rather than being ignored.
      await this.pool.query(`
        SELECT r.subject, r.body_text, r.body_html, r.spam_score, r.category,
          r.sender_legitimacy, r.source_mailbox, d.spam_score, d.category,
          d.sender_legitimacy, d.verify_spam_score, d.verify_category,
          d.verify_sender_legitimacy, a.id, c.id, p.id, rules.id, k.id
        FROM mail_guardian_reviews r, mail_guardian_decisions d,
          mail_guardian_actions a, mail_guardian_accounts c,
          mail_guardian_processed p, mail_guardian_rules rules, mail_guardian_knowledge k
        LIMIT 0
      `);
      return;
    }
    await this.pool.query(`
			CREATE TABLE IF NOT EXISTS mail_guardian_actions (
			  id BIGSERIAL PRIMARY KEY,
			  review_id BIGINT NOT NULL REFERENCES mail_guardian_reviews(id) ON DELETE CASCADE,
			  decision TEXT NOT NULL CHECK (decision IN ('spam','keep','block_sender','allow_sender')),
			  approver TEXT NOT NULL DEFAULT 'dashboard',
			  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','done','failed')),
			  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			  processed_at TIMESTAMPTZ,
			  error TEXT
			)
		`);
    await this.pool.query(`
			CREATE INDEX IF NOT EXISTS idx_mail_guardian_actions_pending
			  ON mail_guardian_actions (requested_at, id)
			  WHERE status = 'pending'
		`);
    await this.pool.query(`
			CREATE TABLE IF NOT EXISTS mail_guardian_accounts (
			  id BIGSERIAL PRIMARY KEY,
			  slug TEXT NOT NULL UNIQUE,
			  address TEXT NOT NULL,
			  host TEXT NOT NULL,
			  port INTEGER NOT NULL DEFAULT 993,
			  secure BOOLEAN NOT NULL DEFAULT true,
			  username TEXT NOT NULL,
			  password_b64 TEXT NOT NULL,
			  inbox TEXT NOT NULL DEFAULT 'INBOX',
			  trash_mailbox TEXT,
			  review_mailbox TEXT NOT NULL DEFAULT 'INBOX.Cortex Mail Guardian Review',
			  enabled BOOLEAN NOT NULL DEFAULT true,
			  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
			)
		`);
    // Display columns for the dashboard's review detail: a plaintext subject
    // and a decoded, human-readable body. Added idempotently so the existing
    // reviews table (created by the dashboard migrations) gains them.
    await this.pool.query(`
		ALTER TABLE mail_guardian_reviews
		  ADD COLUMN IF NOT EXISTS subject TEXT,
		  ADD COLUMN IF NOT EXISTS body_text TEXT,
		  ADD COLUMN IF NOT EXISTS body_html TEXT,
		  ADD COLUMN IF NOT EXISTS spam_score INTEGER,
		  ADD COLUMN IF NOT EXISTS category TEXT,
		  ADD COLUMN IF NOT EXISTS sender_legitimacy TEXT,
		  ADD COLUMN IF NOT EXISTS source_mailbox TEXT NOT NULL DEFAULT 'review'
	`);
    await this.pool.query(`
		ALTER TABLE mail_guardian_decisions
		  ADD COLUMN IF NOT EXISTS spam_score INTEGER,
		  ADD COLUMN IF NOT EXISTS category TEXT,
		  ADD COLUMN IF NOT EXISTS sender_legitimacy TEXT,
		  ADD COLUMN IF NOT EXISTS verify_spam_score INTEGER,
		  ADD COLUMN IF NOT EXISTS verify_category TEXT,
		  ADD COLUMN IF NOT EXISTS verify_sender_legitimacy TEXT
	`);
  }

  async listAccounts(): Promise<AccountRow[]> {
    const result = await this.pool.query<AccountRow>(
      `SELECT slug, address, host, port, secure, username, password_b64,
			        inbox, trash_mailbox, review_mailbox, enabled
			 FROM mail_guardian_accounts
			 WHERE enabled = true
			 ORDER BY slug`,
    );
    return result.rows;
  }

  async hasProcessed(accountSlug: string, uid: number): Promise<boolean> {
    const result = await this.pool.query(
      'SELECT 1 FROM mail_guardian_processed WHERE account_slug = $1 AND message_uid = $2 LIMIT 1',
      [accountSlug, uid],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async markProcessed(
    accountSlug: string,
    uid: number,
    action: string,
    messageId?: string,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO mail_guardian_processed (account_slug, message_uid, message_id, action)
			 VALUES ($1, $2, $3, $4)
			 ON CONFLICT (account_slug, message_uid) DO UPDATE
			   SET action = EXCLUDED.action, processed_at = now()`,
      [accountSlug, uid, messageId ?? null, action],
    );
  }

  async hasAllowRule(fromHash: string, domainHash: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM mail_guardian_rules
			 WHERE rule_type = 'allow' AND value_hash = ANY($1::text[]) LIMIT 1`,
      [[fromHash, domainHash]],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async findRules(fromHash: string, domainHash: string): Promise<RuleMatch[]> {
    const result = await this.pool.query<{
      rule_type: 'allow' | 'block';
      scope: 'sender' | 'domain';
    }>(
      `SELECT rule_type, scope FROM mail_guardian_rules
			 WHERE (scope = 'sender' AND value_hash = $1)
			    OR (scope = 'domain' AND value_hash = $2)`,
      [fromHash, domainHash],
    );
    return result.rows.map((row) => ({
      verdict: row.rule_type === 'block' ? 'spam' : 'ham',
      scope: row.scope,
      ruleType: row.rule_type,
    }));
  }

  async addRule(
    ruleType: 'allow' | 'block',
    scope: 'sender' | 'domain',
    valueHash: string,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO mail_guardian_rules (rule_type, scope, value_hash)
			 VALUES ($1, $2, $3)
			 ON CONFLICT (rule_type, scope, value_hash) DO NOTHING`,
      [ruleType, scope, valueHash],
    );
  }

  async createPendingReview(input: PendingReviewInput): Promise<number> {
    const result = await this.pool.query<{ id: number }>(
      `INSERT INTO mail_guardian_reviews (
		   account_slug, message_uid, message_id, from_hash, domain_hash,
		   subject_hash, body_hash, summary, model_verdict, model_confidence,
		   subject, body_text, body_html, spam_score, category, sender_legitimacy, source_mailbox
		 ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
		 ON CONFLICT (account_slug, message_uid) DO UPDATE
		   SET summary = EXCLUDED.summary,
		       subject = EXCLUDED.subject,
		       body_text = EXCLUDED.body_text,
		       body_html = EXCLUDED.body_html,
		       model_verdict = EXCLUDED.model_verdict,
		       model_confidence = EXCLUDED.model_confidence,
		       spam_score = EXCLUDED.spam_score,
		       category = EXCLUDED.category,
		       sender_legitimacy = EXCLUDED.sender_legitimacy
		 RETURNING id`,
      [
        input.accountSlug,
        input.messageUid,
        input.messageId ?? null,
        input.fromHash,
        input.domainHash,
        input.subjectHash,
        input.bodyHash,
        input.summary,
        input.modelVerdict,
        input.modelConfidence,
        input.subject ?? null,
        input.body ?? null,
        input.bodyHtml ?? null,
        input.spamScore,
        input.category,
        input.senderLegitimacy,
        input.sourceMailbox,
      ],
    );
    return result.rows[0].id;
  }

  async getReview(reviewId: number): Promise<ReviewRecord | null> {
    const result = await this.pool.query<ReviewRecord>(
      `SELECT id, account_slug, message_uid, message_id, from_hash, domain_hash, source_mailbox
			 FROM mail_guardian_reviews
			 WHERE id = $1 AND resolved_at IS NULL`,
      [reviewId],
    );
    return result.rows[0] ?? null;
  }

  async resolveReview(reviewId: number, decision: string, approver: string): Promise<void> {
    await this.pool.query(
      `UPDATE mail_guardian_reviews
			 SET owner_decision = $2, approver = $3, resolved_at = now()
			 WHERE id = $1`,
      [reviewId, decision, approver],
    );
  }

  async enqueueReviewDecision(
    reviewId: number,
    decision: string,
    approver: string,
  ): Promise<number> {
    const result = await this.pool.query<{ id: number }>(
      `INSERT INTO mail_guardian_actions (review_id, decision, approver)
			 VALUES ($1, $2, $3)
			 RETURNING id`,
      [reviewId, decision, approver],
    );
    return result.rows[0].id;
  }

  async claimPendingActions(limit = 20): Promise<QueuedReviewDecision[]> {
    const result = await this.pool.query<QueuedReviewDecision>(
      `WITH next_actions AS (
			   SELECT id
			   FROM mail_guardian_actions
			   WHERE status = 'pending'
			   ORDER BY requested_at, id
			   LIMIT $1
			   FOR UPDATE SKIP LOCKED
			 )
			 UPDATE mail_guardian_actions a
			 SET status = 'processing'
			 FROM next_actions n
			 WHERE a.id = n.id
			 RETURNING a.id, a.review_id, a.decision, a.approver`,
      [limit],
    );
    return result.rows;
  }

  async completeAction(actionId: number): Promise<void> {
    await this.pool.query(
      `UPDATE mail_guardian_actions
			 SET status = 'done', processed_at = now(), error = NULL
			 WHERE id = $1`,
      [actionId],
    );
  }

  async failAction(actionId: number, error: string): Promise<void> {
    await this.pool.query(
      `UPDATE mail_guardian_actions
			 SET status = 'failed', processed_at = now(), error = $2
			 WHERE id = $1`,
      [actionId, error.slice(0, 1000)],
    );
  }

  async recordDecision(input: DecisionInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO mail_guardian_decisions (
         account_slug, message_uid, from_hash, domain_hash, summary,
         model, verdict, confidence, spam_score, category, sender_legitimacy,
         reasons, risk_signals, verify_model, verify_verdict, verify_confidence,
         verify_spam_score, verify_category, verify_sender_legitimacy, outcome
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14,$15,$16,$17,$18,$19,$20)
       ON CONFLICT (account_slug, message_uid) DO UPDATE SET
         model = EXCLUDED.model, verdict = EXCLUDED.verdict,
         confidence = EXCLUDED.confidence, spam_score = EXCLUDED.spam_score,
         category = EXCLUDED.category, sender_legitimacy = EXCLUDED.sender_legitimacy,
         reasons = EXCLUDED.reasons, risk_signals = EXCLUDED.risk_signals,
         verify_model = EXCLUDED.verify_model, verify_verdict = EXCLUDED.verify_verdict,
         verify_confidence = EXCLUDED.verify_confidence,
         verify_spam_score = EXCLUDED.verify_spam_score,
         verify_category = EXCLUDED.verify_category,
         verify_sender_legitimacy = EXCLUDED.verify_sender_legitimacy,
         outcome = EXCLUDED.outcome`,
      [
        input.accountSlug,
        input.messageUid,
        input.fromHash,
        input.domainHash,
        input.summary,
        input.model,
        input.verdict,
        input.confidence,
        input.spamScore,
        input.category,
        input.senderLegitimacy,
        JSON.stringify(input.reasons),
        JSON.stringify(input.riskSignals),
        input.verifyModel,
        input.verifyVerdict,
        input.verifyConfidence,
        input.verifySpamScore,
        input.verifyCategory,
        input.verifySenderLegitimacy,
        input.outcome,
      ],
    );
  }

  /**
   * Persist an owner decision's outcome on the decisions ledger. Most reviews
   * (~350 of 360) never had a model-path decision row, so a bare UPDATE matched
   * nothing and silently dropped the owner's choice — starving `distill` of the
   * owner_* outcomes it filters on. This UPSERTs: when a decision row already
   * exists it patches outcome/decided_at (preserving the model fields); when
   * none exists it INSERTs one carrying the owner outcome plus the identity
   * columns the table requires NOT NULL (from_hash, domain_hash, summary).
   *
   * Relies on the `UNIQUE (account_slug, message_uid)` constraint that
   * migration 015 defines on mail_guardian_decisions.
   */
  async updateDecisionOutcome(
    accountSlug: string,
    uid: number,
    outcome: string,
    identity?: { fromHash?: string; domainHash?: string; summary?: string },
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO mail_guardian_decisions (
         account_slug, message_uid, from_hash, domain_hash, summary, outcome, decided_at
       ) VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (account_slug, message_uid) DO UPDATE
         SET outcome = EXCLUDED.outcome, decided_at = now()`,
      [
        accountSlug,
        uid,
        identity?.fromHash ?? '',
        identity?.domainHash ?? '',
        identity?.summary ?? '',
        outcome,
      ],
    );
  }

  /**
   * Count reviews still awaiting an owner resolution (resolved_at IS NULL).
   * Surfaced as an operational backlog metric each sweep — a large, growing
   * count means the owner-feedback loop has stalled (e.g. notifications are
   * not being delivered) and decisions are piling up unreviewed.
   */
  async countOpenReviews(): Promise<number> {
    const result = await this.pool.query<{ open: string }>(
      `SELECT count(*)::text AS open
       FROM mail_guardian_reviews
       WHERE resolved_at IS NULL`,
    );
    return Number(result.rows[0]?.open ?? 0);
  }

  /**
   * Raise a dashboard operational alert for an open-review backlog, but only
   * when there isn't already an unacknowledged backlog alert from the last
   * hour — so a backlog that persists across sweeps logs one alert, not one
   * per sweep. Best-effort: the `alerts` table is owned by the dashboard schema
   * and may be absent in a bare backend DB, so failures are swallowed (the
   * structured sweep log still carries the count regardless).
   */
  async raiseBacklogAlert(openReviews: number, threshold: number): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO alerts (kind, severity, title, body, source)
         SELECT 'mail_guardian_backlog', 'warn',
                'Mail Guardian review backlog',
                $1, 'cortex-mail-guardian'
         WHERE NOT EXISTS (
           SELECT 1 FROM alerts
           WHERE kind = 'mail_guardian_backlog'
             AND acknowledged_at IS NULL
             AND created_at > now() - interval '1 hour'
         )`,
        [`${openReviews} reviews awaiting an owner decision (threshold ${threshold}).`],
      );
    } catch {
      // alerts table is dashboard-owned and optional for the backend; the
      // structured warning emitted by the sweep is the durable signal.
    }
  }

  async listRecentDecisions(limit: number): Promise<DecisionRow[]> {
    const result = await this.pool.query<DecisionRow>(
      `WITH ranked AS (
         SELECT account_slug, message_uid, from_hash, domain_hash, summary,
                verdict, outcome, created_at,
                row_number() OVER (
                  PARTITION BY CASE WHEN outcome IN ('owner_spam','owner_block') THEN 'spam' ELSE 'keep' END
                  ORDER BY CASE
                    WHEN (verdict = 'spam' AND outcome IN ('owner_keep','owner_allow'))
                      OR (verdict = 'not_spam' AND outcome IN ('owner_spam','owner_block'))
                    THEN 0 ELSE 1 END,
                    created_at DESC
                ) AS class_rank
         FROM mail_guardian_decisions
         WHERE outcome IN ('owner_spam','owner_keep','owner_block','owner_allow')
       )
       SELECT account_slug, message_uid, from_hash, domain_hash, summary,
              verdict, outcome, created_at
       FROM ranked
       WHERE class_rank <= GREATEST(1, $1 / 2)
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit],
    );
    return result.rows;
  }

  async insertBrief(brief: string, sourceDecisions: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO mail_guardian_knowledge (brief, source_decisions) VALUES ($1, $2)`,
      [brief, sourceDecisions],
    );
  }

  async getLatestBrief(): Promise<KnowledgeBriefRow | null> {
    const result = await this.pool.query<KnowledgeBriefRow>(
      `SELECT id, brief, source_decisions, generated_at
       FROM mail_guardian_knowledge
       ORDER BY generated_at DESC, id DESC
       LIMIT 1`,
    );
    return result.rows[0] ?? null;
  }

  async countDomainOutcomes(domainHash: string): Promise<{ spam: number; allow: number }> {
    const result = await this.pool.query<{ spam: string; allow: string }>(
      `SELECT
         COUNT(*) FILTER (WHERE outcome IN ('owner_spam','owner_block')) AS spam,
         COUNT(*) FILTER (WHERE outcome IN ('owner_keep','owner_allow')) AS allow
       FROM mail_guardian_decisions
       WHERE domain_hash = $1`,
      [domainHash],
    );
    const row = result.rows[0];
    return { spam: Number(row?.spam ?? 0), allow: Number(row?.allow ?? 0) };
  }

  async hasRule(
    ruleType: 'allow' | 'block',
    scope: 'sender' | 'domain',
    valueHash: string,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM mail_guardian_rules
       WHERE rule_type = $1 AND scope = $2 AND value_hash = $3 LIMIT 1`,
      [ruleType, scope, valueHash],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async getReviewDomainHash(reviewId: number): Promise<string | null> {
    const result = await this.pool.query<{ domain_hash: string }>(
      `SELECT domain_hash FROM mail_guardian_reviews WHERE id = $1`,
      [reviewId],
    );
    return result.rows[0]?.domain_hash ?? null;
  }

  /**
   * Read review rows needing decode backfill. Returns the identity columns the
   * backfill needs (account_slug, message_uid) plus the current display fields
   * so the caller can diff old vs new. Read-only.
   */
  async listOpenReviews(limit: number, offset: number): Promise<OpenReviewRow[]> {
    const result = await this.pool.query<OpenReviewRow>(
      `SELECT id, account_slug, message_uid, message_id, from_hash, domain_hash, source_mailbox
       FROM mail_guardian_reviews
       WHERE resolved_at IS NULL AND owner_decision IS NULL
       ORDER BY requested_at, id
       LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    return result.rows;
  }

  async listOpenReviewsByIds(ids: number[]): Promise<OpenReviewRow[]> {
    const result = await this.pool.query<OpenReviewRow>(
      `SELECT id, account_slug, message_uid, message_id, from_hash, domain_hash, source_mailbox
       FROM mail_guardian_reviews
       WHERE resolved_at IS NULL AND owner_decision IS NULL AND id = ANY($1::bigint[])
       ORDER BY array_position($1::bigint[], id)`,
      [ids],
    );
    return result.rows;
  }

  async listReviewsForBackfill(): Promise<BackfillReviewRow[]> {
    const result = await this.pool.query<BackfillReviewRow>(
      `SELECT id, account_slug, message_uid, message_id, subject, body_text, summary
       FROM mail_guardian_reviews
       ORDER BY id`,
    );
    return result.rows;
  }

  /**
   * UPDATE-only patch of the decoded display fields on a single review row.
   * Never inserts or deletes. Used by the one-off decode backfill to repair
   * rows that stored undecoded MIME/base64/QP before the decode fix landed.
   */
  async updateReviewDecodedFields(
    id: number,
    fields: { subject?: string; bodyText?: string; summary: string },
    executor: { query: pg.Pool['query'] } = this.pool,
  ): Promise<void> {
    await executor.query(
      `UPDATE mail_guardian_reviews
       SET subject = $2, body_text = $3, summary = $4
       WHERE id = $1`,
      [id, fields.subject ?? null, fields.bodyText ?? null, fields.summary],
    );
  }

  /**
   * Apply many decoded-field patches atomically in one transaction. Idempotent
   * (re-running yields the same decoded values) and UPDATE-only. Used by the
   * decode backfill so a partial run never leaves a mix of old/new rows.
   */
  async updateReviewDecodedFieldsBatch(
    updates: { id: number; subject?: string; bodyText?: string; summary: string }[],
  ): Promise<number> {
    if (updates.length === 0) return 0;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await runSequentially(updates, (update) =>
        this.updateReviewDecodedFields(
          update.id,
          { subject: update.subject, bodyText: update.bodyText, summary: update.summary },
          client,
        ),
      );
      await client.query('COMMIT');
      return updates.length;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
