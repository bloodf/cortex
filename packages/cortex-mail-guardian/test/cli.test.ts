import { describe, expect, it, vi } from 'vitest';
import type { MailAssessment } from '../src/model.js';
import type { ReconcileDeps, ReconcileReview } from '../src/reconcile.js';
import { parseReconcileArgs, reconcileReviews } from '../src/reconcile.js';

const { distillWithDeps } = await import('../src/index.js');

describe('mail guardian distill CLI dispatch', () => {
  it('writes mail_guardian_distill event to stdout and exits 0', async () => {
    let capturedOutput = '';
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: unknown) => {
      capturedOutput += String(chunk);
      return true;
    };

    const stubResult = { sourceDecisions: 3, briefChars: 42 };
    const stubDistillBrief = vi.fn(async () => stubResult);

    const fakeDeps = {
      config: {
        model: 'gpt-4o-mini',
        openAiBaseUrl: 'http://localhost',
        openAiApiKey: 'k',
        dryRun: false,
        accounts: [],
      },
      store: {},
      mail: {},
      telegram: {},
    } as never;

    try {
      await distillWithDeps(fakeDeps, stubDistillBrief);
    } finally {
      process.stdout.write = origWrite;
    }

    expect(stubDistillBrief).toHaveBeenCalledWith(fakeDeps);
    expect(capturedOutput).toContain('"event":"mail_guardian_distill"');
    expect(capturedOutput).toContain('"sourceDecisions":3');
    expect(capturedOutput).toContain('"briefChars":42');
  });
});

const clean: MailAssessment = {
  verdict: 'not_spam',
  spamScore: 2,
  confidence: 0.99,
  category: 'transactional',
  senderLegitimacy: 'legitimate',
  reasons: ['authentic'],
  riskSignals: [],
};

const review = (overrides: Partial<ReconcileReview> = {}): ReconcileReview => ({
  id: 1,
  accountSlug: 'personal',
  messageUid: 7,
  messageId: '<message@example.test>',
  fromHash: 'from-hash',
  domainHash: 'domain-hash',
  sourceMailbox: 'review',
  ...overrides,
});

function harness() {
  const message = {
    uid: 70,
    messageId: '<message@example.test>',
    from: 'Spotify <no-reply@spotify.com>',
    subject: 'Login code',
    text: 'Code 123456',
    hasListUnsubscribe: false,
  };
  const mail = {
    fetchByMessageId: vi.fn(async () => message),
    fetchRawByUid: vi.fn(async () => message),
    moveToInbox: vi.fn(),
    moveToTrash: vi.fn(),
  };
  const deps: ReconcileDeps = {
    accounts: new Map([
      [
        'personal',
        {
          slug: 'personal',
          address: 'me@example.test',
          host: 'mail.example.test',
          port: 993,
          secure: true,
          username: 'me@example.test',
          password: 'secret',
          inbox: 'INBOX',
          reviewMailbox: 'Review',
        },
      ],
    ]),
    mail,
    hasAllowRule: vi.fn(async () => false),
    classify: vi.fn(async () => clean),
    adjudicate: vi.fn(async () => clean),
    shouldTrash: vi.fn(() => false),
  };
  return { deps, mail, message };
}

describe('parseReconcileArgs', () => {
  it('accepts only bounded read-only pagination', () => {
    expect(parseReconcileArgs([])).toEqual({ limit: 10, offset: 0 });
    expect(parseReconcileArgs(['--limit', '5', '--offset', '20'])).toEqual({
      limit: 5,
      offset: 20,
    });
    expect(parseReconcileArgs(['--ids', '893,922,975'])).toEqual({
      limit: 3,
      offset: 0,
      ids: [893, 922, 975],
    });
    expect(parseReconcileArgs(['--ids', '893,922,893'])).toEqual({
      limit: 2,
      offset: 0,
      ids: [893, 922],
    });
    expect(() => parseReconcileArgs(['--ids', '893', '--limit', '1'])).toThrow(
      /cannot be combined/,
    );
    expect(() => parseReconcileArgs(['--ids', '893,nope'])).toThrow(/positive integer IDs/);
    expect(() => parseReconcileArgs(['--ids', '893', '--offset', '1'])).toThrow(
      /cannot be combined/,
    );
    expect(() => parseReconcileArgs(['--limit', '0'])).toThrow(/between 1 and 100/);
    expect(() => parseReconcileArgs(['--limit', '101'])).toThrow(/between 1 and 100/);
    expect(() => parseReconcileArgs(['--offset', '-1'])).toThrow(/between 0 and 10000/);
    expect(() => parseReconcileArgs(['--execute'])).toThrow(/read-only/);
  });
});

describe('reconcileReviews', () => {
  it('scores exact mailbox content without writes or moves', async () => {
    const { deps, mail, message } = harness();

    const result = await reconcileReviews(deps, [review()], { limit: 10, offset: 0 });

    expect(result.summary).toEqual({ examined: 1, keepReview: 1, wouldTrash: 0, failed: 0 });
    expect(result.recommendations[0]).toMatchObject({
      reviewId: 1,
      action: 'keep_review',
      spamScore: 2,
      category: 'transactional',
    });
    expect(mail.fetchByMessageId).toHaveBeenCalledWith(
      expect.anything(),
      'Review',
      '<message@example.test>',
    );
    expect(deps.classify).toHaveBeenCalledWith(expect.objectContaining({ from: message.from }));
    expect(mail.moveToInbox).not.toHaveBeenCalled();
    expect(mail.moveToTrash).not.toHaveBeenCalled();
  });

  it('reads rows already in Inbox from Inbox', async () => {
    const { deps, mail } = harness();

    await reconcileReviews(deps, [review({ sourceMailbox: 'inbox' })], { limit: 10, offset: 0 });

    expect(mail.fetchByMessageId).toHaveBeenCalledWith(
      expect.anything(),
      'INBOX',
      '<message@example.test>',
    );
  });

  it('reports dual-confirmed malicious spam without moving it', async () => {
    const { deps, mail } = harness();
    const malicious: MailAssessment = {
      verdict: 'spam',
      spamScore: 99,
      confidence: 0.99,
      category: 'malicious_spam',
      senderLegitimacy: 'deceptive',
      reasons: ['lookalike'],
      riskSignals: ['credential theft'],
    };
    vi.mocked(deps.classify).mockResolvedValue(malicious);
    vi.mocked(deps.adjudicate).mockResolvedValue(malicious);
    vi.mocked(deps.shouldTrash).mockReturnValue(true);

    const result = await reconcileReviews(deps, [review()], { limit: 10, offset: 0 });

    expect(result.summary).toEqual({ examined: 1, keepReview: 0, wouldTrash: 1, failed: 0 });
    expect(result.recommendations[0]).toMatchObject({ action: 'trash', spamScore: 99 });
    expect(mail.moveToInbox).not.toHaveBeenCalled();
    expect(mail.moveToTrash).not.toHaveBeenCalled();
  });

  it('reports missing messages and provider failures without mutation', async () => {
    const { deps, mail } = harness();
    vi.mocked(mail.fetchByMessageId).mockResolvedValueOnce(undefined);
    vi.mocked(deps.classify).mockRejectedValueOnce(new Error('provider unavailable'));

    const result = await reconcileReviews(deps, [review(), review({ id: 2 })], {
      limit: 10,
      offset: 0,
    });

    expect(result.summary).toEqual({ examined: 2, keepReview: 0, wouldTrash: 0, failed: 2 });
    expect(result.recommendations).toEqual([
      { reviewId: 1, action: 'failed', error: 'message not found' },
      { reviewId: 2, action: 'failed', error: 'provider unavailable' },
    ]);
    expect(mail.moveToInbox).not.toHaveBeenCalled();
    expect(mail.moveToTrash).not.toHaveBeenCalled();
  });
});
