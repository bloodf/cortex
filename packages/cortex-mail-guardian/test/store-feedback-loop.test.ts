import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Behavioral integration test for the revived owner-feedback loop (fix 1.4).
 *
 * Rather than mock a single query, this drives the REAL GuardianStore SQL
 * (updateDecisionOutcome + listRecentDecisions) against an in-memory fake that
 * models the table's `UNIQUE (account_slug, message_uid)` upsert semantics and
 * the `outcome IN (owner_*)` distill filter. It proves the regression fix end
 * to end: an owner decision on a review with NO prior decision row now creates
 * one carrying the owner outcome, and `distill`'s source query then includes it
 * — which the old bare UPDATE could never do (it matched zero rows).
 */

interface DecisionRecord {
  account_slug: string;
  message_uid: number;
  from_hash: string;
  domain_hash: string;
  summary: string;
  verdict: string | null;
  outcome: string;
  decided_at: Date | null;
  created_at: Date;
}

/** Minimal in-memory stand-in for the mail_guardian_decisions table. */
class FakeDecisionsTable {
  readonly rows: DecisionRecord[] = [];

  query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('INSERT INTO mail_guardian_decisions')) {
      return this.upsert(params);
    }
    if (sql.includes('FROM mail_guardian_decisions') && sql.includes('owner_spam')) {
      return this.listOwnerConfirmed(params);
    }
    throw new Error(`unexpected SQL in fake: ${sql.slice(0, 60)}`);
  });

  private upsert(params: unknown[]) {
    const [accountSlug, uid, fromHash, domainHash, summary, outcome] = params as [
      string,
      number,
      string,
      string,
      string,
      string,
    ];
    const existing = this.rows.find((r) => r.account_slug === accountSlug && r.message_uid === uid);
    if (existing) {
      existing.outcome = outcome;
      existing.decided_at = new Date();
    } else {
      this.rows.push({
        account_slug: accountSlug,
        message_uid: uid,
        from_hash: fromHash,
        domain_hash: domainHash,
        summary,
        verdict: null,
        outcome,
        decided_at: new Date(),
        created_at: new Date(),
      });
    }
    return { rows: [], rowCount: 1 };
  }

  private listOwnerConfirmed(params: unknown[]) {
    const limit = params[0] as number;
    const owner = new Set(['owner_spam', 'owner_keep', 'owner_block', 'owner_allow']);
    const rows = this.rows.filter((r) => owner.has(r.outcome)).slice(0, limit);
    return { rows, rowCount: rows.length };
  }
}

const fake = new FakeDecisionsTable();

vi.mock('pg', () => ({
  default: {
    Pool: vi.fn(() => ({
      query: (...a: unknown[]) => fake.query(...(a as [string, unknown[]])),
      end: vi.fn(),
    })),
  },
}));

const { GuardianStore } = await import('../src/store.js');

const config = {
  databaseUrl: 'postgres://test',
  dryRun: false,
  accounts: [],
  model: 'test',
  fallbackModel: 'test-fb',
  openAiBaseUrl: 'http://localhost',
  openAiApiKey: 'key',
  modelTimeoutMs: 5_000,
  confidenceThreshold: 0.95,
  maxMessagesPerSweep: 10,
  db: { host: 'localhost', port: 5432, database: 'test', user: 'test', password: 'test' },
};

describe('owner-feedback loop: updateDecisionOutcome → distill source', () => {
  beforeEach(() => {
    fake.rows.length = 0;
    fake.query.mockClear();
  });

  it('creates a decision row when none exists, so distill can read the owner outcome', async () => {
    const store = new GuardianStore(config as never);

    // A review with NO prior model-path decision row.
    await store.updateDecisionOutcome('example-personal', 12345, 'owner_spam', {
      fromHash: 'from-hash',
      domainHash: 'domain-hash',
    });

    expect(fake.rows).toHaveLength(1);
    expect(fake.rows[0]).toMatchObject({
      account_slug: 'example-personal',
      message_uid: 12345,
      outcome: 'owner_spam',
    });

    // distill's source query now includes the freshly upserted owner outcome.
    const decisions = await store.listRecentDecisions(200);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ outcome: 'owner_spam' });
  });

  it('updates an existing decision row in place rather than inserting a duplicate', async () => {
    const store = new GuardianStore(config as never);

    await store.updateDecisionOutcome('acc', 1, 'owner_keep', {
      fromHash: 'fh',
      domainHash: 'dh',
    });
    await store.updateDecisionOutcome('acc', 1, 'owner_spam', {
      fromHash: 'fh',
      domainHash: 'dh',
    });

    expect(fake.rows).toHaveLength(1);
    expect(fake.rows[0].outcome).toBe('owner_spam');
  });

  it('does not surface a non-owner (pending) outcome to distill', async () => {
    const store = new GuardianStore(config as never);

    // Simulate a pre-existing pending row, then no owner decision applied.
    fake.rows.push({
      account_slug: 'acc',
      message_uid: 9,
      from_hash: 'fh',
      domain_hash: 'dh',
      summary: 's',
      verdict: 'spam',
      outcome: 'pending',
      decided_at: null,
      created_at: new Date(),
    });

    const decisions = await store.listRecentDecisions(200);
    expect(decisions).toHaveLength(0);
  });
});
