import { beforeEach, describe, expect, it, vi } from 'vitest';
import { redactEmail } from '../src/redact.js';

const querySpy = vi.hoisted(() => vi.fn());

vi.mock('pg', () => ({
  default: {
    Pool: vi.fn(() => ({
      query: querySpy,
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

describe('GuardianStore.recordDecision', () => {
  beforeEach(() => {
    querySpy.mockReset();
    querySpy.mockResolvedValue({ rows: [], rowCount: 1 });
  });

  it('upserts a decision row with all non-null fields', async () => {
    const store = new GuardianStore(config as never);
    const redacted = redactEmail({ from: 'sender@example.test', subject: 'hello', text: 'body' });

    await store.recordDecision({
      accountSlug: 'test-account',
      messageUid: 42,
      fromHash: redacted.fromHash,
      domainHash: redacted.domainHash,
      summary: redacted.summary,
      model: 'gpt-4o-mini',
      verdict: 'spam',
      confidence: 0.98,
      reasons: ['phishing'],
      riskSignals: ['credential request'],
      verifyModel: 'gpt-4o',
      verifyVerdict: 'spam',
      verifyConfidence: 0.95,
      outcome: 'pending',
    });

    expect(querySpy).toHaveBeenCalledOnce();
    const [sql, params] = querySpy.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('mail_guardian_decisions');
    expect(sql).toContain('ON CONFLICT');
    expect(params).toContain(redacted.fromHash);
    expect(params).toContain(redacted.domainHash);
    expect(params).toContain(redacted.summary);
    expect(params).toContain('gpt-4o-mini');
    expect(params).toContain('spam');
    expect(params).toContain(0.98);
    expect(params).toContain('gpt-4o');
    expect(params).toContain('pending');
  });

  it('passes reasons and risk_signals as serialised JSON', async () => {
    const store = new GuardianStore(config as never);
    const redacted = redactEmail({ from: 'x@y.test', subject: 's', text: 't' });

    await store.recordDecision({
      accountSlug: 'acc',
      messageUid: 1,
      fromHash: redacted.fromHash,
      domainHash: redacted.domainHash,
      summary: redacted.summary,
      model: null,
      verdict: null,
      confidence: null,
      reasons: ['reason-a', 'reason-b'],
      riskSignals: ['signal-x'],
      verifyModel: null,
      verifyVerdict: null,
      verifyConfidence: null,
      outcome: 'pending',
    });

    const params = querySpy.mock.calls[0][1] as unknown[];
    const reasonsParam = params.find((p) => typeof p === 'string' && p.includes('reason-a'));
    const signalsParam = params.find((p) => typeof p === 'string' && p.includes('signal-x'));
    expect(JSON.parse(reasonsParam as string)).toEqual(['reason-a', 'reason-b']);
    expect(JSON.parse(signalsParam as string)).toEqual(['signal-x']);
  });
});

describe('GuardianStore.updateDecisionOutcome', () => {
  beforeEach(() => {
    querySpy.mockReset();
  });

  it('upserts the owner outcome (INSERT ... ON CONFLICT) so it always persists', async () => {
    querySpy.mockResolvedValue({ rows: [], rowCount: 1 });
    const store = new GuardianStore(config as never);

    await store.updateDecisionOutcome('test-account', 42, 'owner_spam', {
      fromHash: 'fh',
      domainHash: 'dh',
    });

    expect(querySpy).toHaveBeenCalledOnce();
    const [sql, params] = querySpy.mock.calls[0] as [string, unknown[]];
    // Must be an UPSERT, not a bare UPDATE — reviews may have no decision row,
    // so a plain UPDATE would match nothing and silently drop the owner choice.
    expect(sql).toContain('INSERT INTO mail_guardian_decisions');
    expect(sql).toContain('ON CONFLICT (account_slug, message_uid)');
    expect(sql).toContain('outcome = EXCLUDED.outcome');
    expect(sql).toContain('decided_at');
    expect(params).toContain('test-account');
    expect(params).toContain(42);
    expect(params).toContain('owner_spam');
    expect(params).toContain('fh');
    expect(params).toContain('dh');
  });

  it('supplies safe defaults for the NOT NULL identity columns when omitted', async () => {
    querySpy.mockResolvedValue({ rows: [], rowCount: 1 });
    const store = new GuardianStore(config as never);

    await store.updateDecisionOutcome('acc', 7, 'owner_keep');

    const [sql, params] = querySpy.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('from_hash');
    expect(sql).toContain('domain_hash');
    expect(sql).toContain('summary');
    // from_hash / domain_hash / summary default to '' (NOT NULL satisfied).
    expect(params.filter((p) => p === '')).toHaveLength(3);
    expect(params).toContain('owner_keep');
  });

  it('resolves without throwing', async () => {
    querySpy.mockResolvedValue({ rows: [], rowCount: 1 });
    const store = new GuardianStore(config as never);

    await expect(
      store.updateDecisionOutcome('old-account', 99, 'owner_keep'),
    ).resolves.toBeUndefined();
  });
});

describe('GuardianStore.countOpenReviews', () => {
  beforeEach(() => {
    querySpy.mockReset();
  });

  it('counts reviews with no owner resolution (resolved_at IS NULL)', async () => {
    querySpy.mockResolvedValue({ rows: [{ open: '314' }], rowCount: 1 });
    const store = new GuardianStore(config as never);

    const count = await store.countOpenReviews();

    expect(querySpy).toHaveBeenCalledOnce();
    const [sql] = querySpy.mock.calls[0] as [string];
    expect(sql).toContain('mail_guardian_reviews');
    expect(sql).toContain('resolved_at IS NULL');
    expect(count).toBe(314);
  });

  it('returns numeric zero when there are no open reviews', async () => {
    querySpy.mockResolvedValue({ rows: [{ open: '0' }], rowCount: 1 });
    const store = new GuardianStore(config as never);

    expect(await store.countOpenReviews()).toBe(0);
  });
});

describe('GuardianStore.raiseBacklogAlert', () => {
  beforeEach(() => {
    querySpy.mockReset();
  });

  it('inserts a warn alert guarded against duplicate recent alerts', async () => {
    querySpy.mockResolvedValue({ rows: [], rowCount: 1 });
    const store = new GuardianStore(config as never);

    await store.raiseBacklogAlert(314, 100);

    expect(querySpy).toHaveBeenCalledOnce();
    const [sql, params] = querySpy.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO alerts');
    expect(sql).toContain('mail_guardian_backlog');
    expect(sql).toContain('NOT EXISTS');
    expect(params[0] as string).toContain('314');
    expect(params[0] as string).toContain('100');
  });

  it('swallows errors when the alerts table is absent (dashboard-owned)', async () => {
    querySpy.mockRejectedValue(new Error('relation "alerts" does not exist'));
    const store = new GuardianStore(config as never);

    await expect(store.raiseBacklogAlert(200, 100)).resolves.toBeUndefined();
  });
});

describe('GuardianStore.listRecentDecisions', () => {
  beforeEach(() => {
    querySpy.mockReset();
    querySpy.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it('queries only owner-confirmed outcomes (not pending or model-path outcomes)', async () => {
    const store = new GuardianStore(config as never);

    await store.listRecentDecisions(50);

    expect(querySpy).toHaveBeenCalledOnce();
    const [sql, params] = querySpy.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('owner_spam');
    expect(sql).toContain('owner_keep');
    expect(sql).toContain('owner_block');
    expect(sql).toContain('owner_allow');
    expect(sql).not.toContain("!= 'pending'");
    expect(sql).not.toContain('auto_trashed');
    expect(params).toContain(50);
  });

  it('orders disagreements first, then created_at DESC', async () => {
    const store = new GuardianStore(config as never);

    await store.listRecentDecisions(100);

    const [sql] = querySpy.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('ORDER BY');
    expect(sql).toContain('created_at DESC');
    expect(sql).toMatch(/CASE/i);
    expect(sql).toContain("verdict = 'spam'");
  });

  it('returns mapped rows', async () => {
    querySpy.mockResolvedValue({
      rows: [
        {
          account_slug: 'acc',
          message_uid: 1,
          from_hash: 'fh',
          domain_hash: 'dh',
          summary: 's',
          verdict: 'spam',
          outcome: 'owner_keep',
          created_at: new Date(),
        },
      ],
      rowCount: 1,
    });
    const store = new GuardianStore(config as never);

    const rows = await store.listRecentDecisions(10);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ summary: 's', verdict: 'spam', outcome: 'owner_keep' });
  });
});

describe('GuardianStore.listOpenReviewsByIds', () => {
  beforeEach(() => {
    querySpy.mockReset();
    querySpy.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it('selects only unresolved owner-undecided rows in requested ID order', async () => {
    const store = new GuardianStore(config as never);
    await store.listOpenReviewsByIds([893, 922, 975]);

    const [sql, params] = querySpy.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('resolved_at IS NULL');
    expect(sql).toContain('owner_decision IS NULL');
    expect(sql).toContain('id = ANY($1::bigint[])');
    expect(sql).toContain('array_position');
    expect(params).toEqual([[893, 922, 975]]);
  });
});
describe('GuardianStore.insertBrief', () => {
  beforeEach(() => {
    querySpy.mockReset();
    querySpy.mockResolvedValue({ rows: [], rowCount: 1 });
  });

  it('inserts into mail_guardian_knowledge with brief and source_decisions', async () => {
    const store = new GuardianStore(config as never);

    await store.insertBrief('Owner prefers no newsletters.', 42);

    expect(querySpy).toHaveBeenCalledOnce();
    const [sql, params] = querySpy.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('mail_guardian_knowledge');
    expect(sql).toContain('INSERT');
    expect(params).toContain('Owner prefers no newsletters.');
    expect(params).toContain(42);
  });
});

describe('GuardianStore.getLatestBrief', () => {
  beforeEach(() => {
    querySpy.mockReset();
  });

  it('returns null when table is empty', async () => {
    querySpy.mockResolvedValue({ rows: [], rowCount: 0 });
    const store = new GuardianStore(config as never);

    const result = await store.getLatestBrief();

    expect(result).toBeNull();
  });

  it('returns the most recent brief ordered by generated_at DESC, id DESC', async () => {
    const row = { id: 7, brief: 'brief text', source_decisions: 5, generated_at: new Date() };
    querySpy.mockResolvedValue({ rows: [row], rowCount: 1 });
    const store = new GuardianStore(config as never);

    const result = await store.getLatestBrief();

    expect(result).toMatchObject({ id: 7, brief: 'brief text', source_decisions: 5 });
    const [sql] = querySpy.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('ORDER BY generated_at DESC');
    expect(sql).toContain('id DESC');
  });
});

describe('GuardianStore.countDomainOutcomes', () => {
  beforeEach(() => {
    querySpy.mockReset();
  });

  it('counts owner-confirmed spam and allow outcomes for a domain hash', async () => {
    querySpy.mockResolvedValue({ rows: [{ spam: '3', allow: '1' }], rowCount: 1 });
    const store = new GuardianStore(config as never);

    const result = await store.countDomainOutcomes('domain-hash-xyz');

    expect(querySpy).toHaveBeenCalledOnce();
    const [sql, params] = querySpy.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('mail_guardian_decisions');
    expect(sql).toContain('owner_spam');
    expect(sql).toContain('owner_block');
    expect(sql).toContain('owner_keep');
    expect(sql).toContain('owner_allow');
    expect(params).toContain('domain-hash-xyz');
    expect(result).toEqual({ spam: 3, allow: 1 });
  });

  it('excludes auto_trashed and pending outcomes', async () => {
    querySpy.mockResolvedValue({ rows: [{ spam: '0', allow: '0' }], rowCount: 1 });
    const store = new GuardianStore(config as never);

    await store.countDomainOutcomes('dh');

    const [sql] = querySpy.mock.calls[0] as [string];
    expect(sql).not.toContain('auto_trashed');
  });

  it('returns numeric zero counts when domain has no decisions', async () => {
    querySpy.mockResolvedValue({ rows: [{ spam: '0', allow: '0' }], rowCount: 1 });
    const store = new GuardianStore(config as never);

    const result = await store.countDomainOutcomes('unknown-hash');

    expect(result).toEqual({ spam: 0, allow: 0 });
  });
});

describe('GuardianStore.hasRule', () => {
  beforeEach(() => {
    querySpy.mockReset();
  });

  it('returns true when a matching rule exists', async () => {
    querySpy.mockResolvedValue({ rows: [{ 1: 1 }], rowCount: 1 });
    const store = new GuardianStore(config as never);

    const result = await store.hasRule('block', 'domain', 'some-hash');

    expect(querySpy).toHaveBeenCalledOnce();
    const [sql, params] = querySpy.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('mail_guardian_rules');
    expect(params).toContain('block');
    expect(params).toContain('domain');
    expect(params).toContain('some-hash');
    expect(result).toBe(true);
  });

  it('returns false when no matching rule exists', async () => {
    querySpy.mockResolvedValue({ rows: [], rowCount: 0 });
    const store = new GuardianStore(config as never);

    const result = await store.hasRule('allow', 'domain', 'no-hash');

    expect(result).toBe(false);
  });
});

describe('GuardianStore.getReviewDomainHash', () => {
  beforeEach(() => {
    querySpy.mockReset();
  });

  it('returns domain_hash for a review id without resolved_at filter', async () => {
    querySpy.mockResolvedValue({ rows: [{ domain_hash: 'dh-abc' }], rowCount: 1 });
    const store = new GuardianStore(config as never);

    const result = await store.getReviewDomainHash(55);

    expect(querySpy).toHaveBeenCalledOnce();
    const [sql, params] = querySpy.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('mail_guardian_reviews');
    expect(sql).toContain('domain_hash');
    expect(sql).not.toContain('resolved_at');
    expect(params).toContain(55);
    expect(result).toBe('dh-abc');
  });

  it('returns null when review does not exist', async () => {
    querySpy.mockResolvedValue({ rows: [], rowCount: 0 });
    const store = new GuardianStore(config as never);

    const result = await store.getReviewDomainHash(999);

    expect(result).toBeNull();
  });
});
