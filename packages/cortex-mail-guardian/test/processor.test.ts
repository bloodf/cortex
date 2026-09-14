import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProcessDeps } from '../src/processor.js';
import {
  applyReviewDecision,
  buildReviewMessage,
  handleTelegramUpdates,
  processMessage,
  sweep,
} from '../src/processor.js';

const assessment = {
  verdict: 'uncertain' as const,
  spamScore: 50,
  confidence: 0.5,
  category: 'suspicious' as const,
  senderLegitimacy: 'unknown' as const,
  reasons: [] as string[],
  riskSignals: [] as string[],
};
const classifyEmailMock = vi.fn(async () => assessment);
const adjudicateEmailMock = vi.fn(async () => assessment);
const shouldAutoQuarantineMock = vi.fn(() => false);
const shouldKeepInInboxMock = vi.fn(() => false);

vi.mock('../src/model.js', () => ({
  classifyEmail: (...args: unknown[]) => classifyEmailMock(...args),
  adjudicateEmail: (...args: unknown[]) => adjudicateEmailMock(...args),
  shouldAutoQuarantine: (...args: unknown[]) => shouldAutoQuarantineMock(...args),
  shouldKeepInInbox: (...args: unknown[]) => shouldKeepInInboxMock(...args),
}));

beforeEach(() => {
  classifyEmailMock.mockReset();
  classifyEmailMock.mockResolvedValue(assessment);
  adjudicateEmailMock.mockReset();
  adjudicateEmailMock.mockResolvedValue(assessment);
  shouldAutoQuarantineMock.mockReset();
  shouldAutoQuarantineMock.mockReturnValue(false);
  shouldKeepInInboxMock.mockReset();
  shouldKeepInInboxMock.mockReturnValue(false);
});

function account(slug: string) {
  return {
    slug,
    address: `${slug}@example.test`,
    host: 'mail.example.test',
    port: 993,
    secure: true,
    username: `${slug}@example.test`,
    password: 'secret',
    inbox: 'INBOX',
    reviewMailbox: 'Cortex Mail Guardian Review',
  };
}

const baseConfig = {
  openAiBaseUrl: 'http://127.0.0.1:11434/v1',
  openAiApiKey: 'test',
  model: 'minimax/MiniMax-M3',
  fallbackModel: 'minimax/MiniMax-M3',
  modelTimeoutMs: 30_000,
  confidenceThreshold: 0.98,
  dryRun: false,
};

describe('mail guardian sweep', () => {
  it('does not let skipped messages consume the per-account processing cap', async () => {
    const accounts = [account('one'), account('two'), account('three')];
    const listed: string[] = [];
    const deps = {
      config: {
        accounts,
        maxMessagesPerSweep: 1,
        ...baseConfig,
        dryRun: true,
      },
      store: {
        hasProcessed: async (_accountSlug: string, uid: number) => uid === 1,
        findRules: async () => [],
        hasAllowRule: async () => false,
        getLatestBrief: async () => null,
        createPendingReview: async () => 10,
        markProcessed: async () => undefined,
        recordDecision: async () => undefined,
        claimPendingActions: async () => [],
        countOpenReviews: async () => 0,
        raiseBacklogAlert: async () => undefined,
      },
      telegram: {
        sendMessage: async () => undefined,
      },
      mail: {
        listInbox: async (mailAccount: { slug: string }) => {
          listed.push(mailAccount.slug);
          return [
            { uid: 1, from: 'sender@example.test', subject: 'first', text: 'first' },
            { uid: 2, from: 'sender@example.test', subject: 'second', text: 'second' },
          ];
        },
        moveToReview: async () => undefined,
      },
    } as unknown as ProcessDeps;

    await expect(sweep(deps)).resolves.toMatchObject({ processed: 6, review: 3, skipped: 3 });
    expect(listed).toEqual(['one', 'two', 'three']);
  });
});

describe('mail guardian open-review backlog metric', () => {
  function backlogDeps(openReviews: number) {
    const raiseBacklogAlert = vi.fn(async () => undefined);
    const deps = {
      config: { accounts: [], maxMessagesPerSweep: 1, ...baseConfig },
      store: {
        claimPendingActions: async () => [],
        countOpenReviews: async () => openReviews,
        raiseBacklogAlert,
      },
      telegram: { sendMessage: async () => undefined },
      mail: { listInbox: async () => [], moveToReview: async () => undefined },
    } as unknown as ProcessDeps;
    return { deps, raiseBacklogAlert };
  }

  it('exposes the open-review count in the sweep result', async () => {
    const { deps } = backlogDeps(42);
    await expect(sweep(deps)).resolves.toMatchObject({ openReviews: 42 });
  });

  it('warns and raises an alert when the backlog exceeds the threshold', async () => {
    const warnings: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      warnings.push(String(chunk));
      return true;
    });
    const { deps, raiseBacklogAlert } = backlogDeps(314);

    await sweep(deps);

    spy.mockRestore();
    const warning = warnings.find((w) => w.includes('mail_guardian_backlog_warning'));
    expect(warning).toBeDefined();
    expect(warning).toContain('"openReviews":314');
    expect(raiseBacklogAlert).toHaveBeenCalledWith(314, 100);
  });

  it('stays silent when the backlog is within the threshold', async () => {
    const { deps, raiseBacklogAlert } = backlogDeps(5);
    await sweep(deps);
    expect(raiseBacklogAlert).not.toHaveBeenCalled();
  });
});

describe('mail guardian rule pre-filter', () => {
  it('trashes a message matched by a block rule without calling the model', async () => {
    const moved: { slug: string; uid: number }[] = [];
    const processed: { slug: string; uid: number; action: string }[] = [];
    const recordDecisionCalls: unknown[] = [];
    const deps = {
      config: { accounts: [account('one')], dryRun: false, maxMessagesPerSweep: 10 },
      store: {
        hasProcessed: async () => false,
        findRules: async () => [{ verdict: 'spam', scope: 'sender', ruleType: 'block' }],
        markProcessed: async (slug: string, uid: number, action: string) => {
          processed.push({ slug, uid, action });
        },
        recordDecision: async (...args: unknown[]) => {
          recordDecisionCalls.push(args);
        },
      },
      mail: {
        moveToTrash: async (mailAccount: { slug: string }, uid: number) => {
          moved.push({ slug: mailAccount.slug, uid });
          return 'Trash';
        },
      },
    } as unknown as ProcessDeps;

    const result = await processMessage(deps, account('one'), {
      uid: 7,
      from: 'blocked@spam.test',
      subject: 'x',
      text: 'y',
    });

    expect(result).toBe('trashed');
    expect(moved).toEqual([{ slug: 'one', uid: 7 }]);
    expect(processed).toEqual([{ slug: 'one', uid: 7, action: 'trashed' }]);
    expect(classifyEmailMock).not.toHaveBeenCalled();
    expect(adjudicateEmailMock).not.toHaveBeenCalled();
    expect(recordDecisionCalls).toHaveLength(0);
  });
});

describe('mail guardian Telegram review message', () => {
  it('shows only sender and subject, not body or generated summaries', () => {
    const message = buildReviewMessage({
      accountAddress: 'inbox@example.test',
      from: 'Sender <sender@example.test>',
      subject: 'Quarterly invoice',
      verdict: 'uncertain',
      confidence: 0.61,
      reviewId: 123,
    });

    expect(message).toContain('From: Sender <sender@example.test>');
    expect(message).toContain('Subject: Quarterly invoice');
    expect(message).not.toContain('Summary:');
    expect(message).not.toContain('Body:');
    expect(message).not.toContain('invoice body private details');
  });
});

describe('mail guardian review decisions', () => {
  it('trashes one message without blocking its sender', async () => {
    const rules: { ruleType: string; scope: string; valueHash: string }[] = [];
    const moved: { slug: string; uid: number }[] = [];
    const processed: { slug: string; uid: number; action: string }[] = [];
    const outcomeUpdates: { accountSlug: string; uid: number; outcome: string }[] = [];
    const resolveOrder: string[] = [];

    const deps = {
      config: {
        accounts: [account('one')],
        dryRun: false,
      },
      store: {
        getReview: async () => ({
          id: 42,
          account_slug: 'one',
          message_uid: 101,
          message_id: '<message-101@example.test>',
          from_hash: 'sender-hash',
          domain_hash: 'domain-hash',
        }),
        addRule: async (ruleType: string, scope: string, valueHash: string) => {
          rules.push({ ruleType, scope, valueHash });
        },
        markProcessed: async (slug: string, uid: number, action: string) => {
          processed.push({ slug, uid, action });
        },
        updateDecisionOutcome: async (accountSlug: string, uid: number, outcome: string) => {
          outcomeUpdates.push({ accountSlug, uid, outcome });
          resolveOrder.push('updateDecisionOutcome');
        },
        resolveReview: async () => {
          resolveOrder.push('resolveReview');
        },
      },
      mail: {
        moveToTrash: async (mailAccount: { slug: string }, uid: number) => {
          moved.push({ slug: mailAccount.slug, uid });
          return 'Trash';
        },
      },
    } as unknown as ProcessDeps;

    await applyReviewDecision(deps, 42, 'spam', 'telegram');

    expect(moved).toEqual([{ slug: 'one', uid: 101 }]);
    expect(processed).toEqual([{ slug: 'one', uid: 101, action: 'trashed' }]);
    expect(rules).toEqual([]);
    expect(outcomeUpdates).toEqual([{ accountSlug: 'one', uid: 101, outcome: 'owner_spam' }]);
    expect(resolveOrder).toEqual(['updateDecisionOutcome', 'resolveReview']);
  });

  it('resolves Keep in place when the reviewed message is already in Inbox', async () => {
    const moveToInbox = vi.fn();
    const addRule = vi.fn();
    const deps = {
      config: { accounts: [account('one')], dryRun: false },
      store: {
        getReview: async () => ({
          id: 43,
          account_slug: 'one',
          message_uid: 102,
          message_id: '<message-102@example.test>',
          from_hash: 'sender-hash',
          domain_hash: 'domain-hash',
          source_mailbox: 'inbox',
        }),
        addRule,
        markProcessed: async () => undefined,
        updateDecisionOutcome: async () => undefined,
        resolveReview: async () => undefined,
      },
      mail: { moveToInbox },
    } as unknown as ProcessDeps;

    await applyReviewDecision(deps, 43, 'keep', 'dashboard');

    expect(moveToInbox).not.toHaveBeenCalled();
    expect(addRule).not.toHaveBeenCalled();
  });

  it('creates a sender rule only for Block sender', async () => {
    const addRule = vi.fn(async () => undefined);
    const deps = {
      config: { accounts: [account('one')], dryRun: false },
      store: {
        getReview: async () => ({
          id: 44,
          account_slug: 'one',
          message_uid: 103,
          message_id: '<message-103@example.test>',
          from_hash: 'sender-hash',
          domain_hash: 'domain-hash',
          source_mailbox: 'inbox',
        }),
        addRule,
        markProcessed: async () => undefined,
        updateDecisionOutcome: async () => undefined,
        resolveReview: async () => undefined,
        countDomainOutcomes: async () => ({ spam: 1, allow: 0 }),
      },
      mail: { moveToTrash: async () => undefined },
      telegram: { sendMessage: async () => undefined },
    } as unknown as ProcessDeps;

    await applyReviewDecision(deps, 44, 'block_sender', 'dashboard');

    expect(addRule).toHaveBeenCalledWith('block', 'sender', 'sender-hash');
  });
});

describe('mail guardian processMessage — AI action policy', () => {
  function depsFor(decisions: unknown[], moved: number[], processed: string[]) {
    return {
      config: { accounts: [account('one')], ...baseConfig },
      store: {
        hasProcessed: async () => false,
        findRules: async () => [],
        hasAllowRule: async () => false,
        getLatestBrief: async () => null,
        createPendingReview: async () => 55,
        markProcessed: async (_slug: string, _uid: number, action: string) =>
          processed.push(action),
        resolveReview: async () => undefined,
        recordDecision: async (input: unknown) => decisions.push(input),
      },
      mail: { moveToTrash: async (_account: unknown, uid: number) => moved.push(uid) },
      telegram: { sendMessage: async () => undefined },
    } as unknown as ProcessDeps;
  }

  it('trashes only when strict dual-pass policy approves', async () => {
    const malicious = {
      ...assessment,
      verdict: 'spam' as const,
      spamScore: 99,
      confidence: 0.99,
      category: 'malicious_spam' as const,
      senderLegitimacy: 'deceptive' as const,
      reasons: ['lookalike domain'],
      riskSignals: ['credential theft'],
    };
    classifyEmailMock.mockResolvedValue(malicious);
    adjudicateEmailMock.mockResolvedValue(malicious);
    shouldAutoQuarantineMock.mockReturnValue(true);
    const decisions: unknown[] = [];
    const moved: number[] = [];
    const processed: string[] = [];

    await expect(
      processMessage(depsFor(decisions, moved, processed), account('one'), {
        uid: 42,
        from: 'spammer@evil.test',
        subject: 'Verify account',
        text: 'Steal credentials',
        hasListUnsubscribe: false,
      }),
    ).resolves.toBe('trashed');

    expect(moved).toEqual([42]);
    expect(processed).toContain('trashed');
    expect(decisions[0]).toMatchObject({
      model: 'minimax/MiniMax-M3',
      verifyModel: 'minimax/MiniMax-M3',
      spamScore: 99,
      verifySpamScore: 99,
      outcome: 'auto_trashed',
    });
  });
});

describe('mail guardian processMessage — clean AI consensus', () => {
  it('keeps legitimate mail without creating a review or Telegram notification', async () => {
    const legitimate = {
      ...assessment,
      verdict: 'not_spam' as const,
      spamScore: 2,
      confidence: 0.99,
      category: 'transactional' as const,
      senderLegitimacy: 'legitimate' as const,
    };
    classifyEmailMock.mockResolvedValue(legitimate);
    adjudicateEmailMock.mockResolvedValue(legitimate);
    shouldKeepInInboxMock.mockReturnValue(true);
    const createPendingReview = vi.fn();
    const sendMessage = vi.fn();
    const decisions: unknown[] = [];
    const processed: string[] = [];
    const deps = {
      config: { accounts: [account('one')], ...baseConfig },
      store: {
        hasProcessed: async () => false,
        findRules: async () => [],
        hasAllowRule: async () => false,
        getLatestBrief: async () => null,
        createPendingReview,
        markProcessed: async (_slug: string, _uid: number, action: string) =>
          processed.push(action),
        recordDecision: async (input: unknown) => decisions.push(input),
      },
      mail: {},
      telegram: { sendMessage },
    } as unknown as ProcessDeps;

    await expect(
      processMessage(deps, account('one'), {
        uid: 6,
        from: 'alerts@spotify.com',
        subject: 'Login code',
        text: 'Code 123456',
        hasListUnsubscribe: false,
      }),
    ).resolves.toBe('kept');

    expect(createPendingReview).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(processed).toContain('kept');
    expect(decisions[0]).toMatchObject({ outcome: 'kept', spamScore: 2 });
  });
});

describe('mail guardian processMessage — fail open', () => {
  it('keeps mail in Inbox and records classify_failed when AI throws', async () => {
    classifyEmailMock.mockRejectedValueOnce(new Error('model error'));
    const processed: string[] = [];
    const moveToReview = vi.fn();
    const deps = {
      config: { accounts: [account('one')], ...baseConfig },
      store: {
        hasProcessed: async () => false,
        findRules: async () => [],
        hasAllowRule: async () => false,
        getLatestBrief: async () => null,
        createPendingReview: async () => 77,
        markProcessed: async (_slug: string, _uid: number, action: string) =>
          processed.push(action),
        recordDecision: async () => undefined,
      },
      mail: { moveToReview },
      telegram: { sendMessage: async () => undefined },
    } as unknown as ProcessDeps;

    await expect(
      processMessage(deps, account('one'), {
        uid: 10,
        from: 'x@y.test',
        subject: 'test',
        text: 'body',
        hasListUnsubscribe: false,
      }),
    ).resolves.toBe('review');
    expect(processed).toContain('classify_failed');
    expect(moveToReview).not.toHaveBeenCalled();
  });

  it('keeps legitimate mail in Inbox when adjudication fails', async () => {
    classifyEmailMock.mockResolvedValueOnce({
      ...assessment,
      verdict: 'not_spam',
      spamScore: 1,
      confidence: 0.99,
      category: 'transactional',
      senderLegitimacy: 'legitimate',
    });
    adjudicateEmailMock.mockRejectedValueOnce(new Error('verify error'));
    const processed: string[] = [];
    const moveToReview = vi.fn();
    const deps = {
      config: { accounts: [account('one')], ...baseConfig },
      store: {
        hasProcessed: async () => false,
        findRules: async () => [],
        hasAllowRule: async () => false,
        getLatestBrief: async () => null,
        createPendingReview: async () => 78,
        markProcessed: async (_slug: string, _uid: number, action: string) =>
          processed.push(action),
        recordDecision: async () => undefined,
      },
      mail: { moveToReview },
      telegram: { sendMessage: async () => undefined },
    } as unknown as ProcessDeps;

    await expect(
      processMessage(deps, account('one'), {
        uid: 11,
        from: 'alerts@spotify.com',
        subject: 'Login code',
        text: 'Code 123456',
        hasListUnsubscribe: false,
      }),
    ).resolves.toBe('review');
    expect(processed).toContain('classify_failed');
    expect(moveToReview).not.toHaveBeenCalled();
  });

  it('keeps mail in Inbox when analysis and adjudication disagree', async () => {
    classifyEmailMock.mockResolvedValueOnce({
      ...assessment,
      verdict: 'spam',
      spamScore: 99,
      confidence: 0.99,
      category: 'malicious_spam',
      senderLegitimacy: 'deceptive',
      riskSignals: ['lookalike domain'],
    });
    adjudicateEmailMock.mockResolvedValueOnce({
      ...assessment,
      verdict: 'not_spam',
      spamScore: 3,
      confidence: 0.99,
      category: 'legitimate_marketing',
      senderLegitimacy: 'legitimate',
    });
    const moveToTrash = vi.fn();
    const deps = {
      config: { accounts: [account('one')], ...baseConfig },
      store: {
        hasProcessed: async () => false,
        findRules: async () => [],
        hasAllowRule: async () => false,
        getLatestBrief: async () => null,
        createPendingReview: async () => 79,
        markProcessed: async () => undefined,
        recordDecision: async () => undefined,
      },
      mail: { moveToTrash },
      telegram: { sendMessage: async () => undefined },
    } as unknown as ProcessDeps;

    await expect(
      processMessage(deps, account('one'), {
        uid: 12,
        from: 'news@hostgator.com',
        subject: 'Service news',
        text: 'New features',
        hasListUnsubscribe: true,
      }),
    ).resolves.toBe('review');
    expect(moveToTrash).not.toHaveBeenCalled();
  });
});

describe('mail guardian processMessage — independent adjudication', () => {
  it('passes first assessment and owner feedback to adjudication', async () => {
    const deps = {
      config: { accounts: [account('one')], ...baseConfig },
      store: {
        hasProcessed: async () => false,
        findRules: async () => [],
        hasAllowRule: async () => false,
        getLatestBrief: async () => ({ brief: 'keep legitimate brands' }),
        createPendingReview: async () => 44,
        markProcessed: async () => undefined,
        recordDecision: async () => undefined,
      },
      mail: {},
      telegram: { sendMessage: async () => undefined },
    } as unknown as ProcessDeps;

    await processMessage(deps, account('one'), {
      uid: 30,
      from: 'brand@example.test',
      subject: 'newsletter',
      text: 'news',
      hasListUnsubscribe: true,
    });

    expect(classifyEmailMock).toHaveBeenCalledOnce();
    expect(adjudicateEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'minimax/MiniMax-M3' }),
      expect.objectContaining({ feedbackSummary: 'keep legitimate brands' }),
      assessment,
    );
  });
});

describe('mail guardian applyReviewDecision — domain block proposal', () => {
  it('sends domain block proposal when spam >= 3 and no allow or existing domain rule', async () => {
    const sentMessages: unknown[][] = [];
    const deps = {
      config: {
        accounts: [account('one')],
        dryRun: false,
        telegramBotToken: 'test-token',
        telegramOwnerChatId: '777',
      },
      store: {
        getReview: async () => ({
          id: 10,
          account_slug: 'one',
          message_uid: 200,
          message_id: null,
          from_hash: 'fh',
          domain_hash: 'bulk-domain-hash',
        }),
        addRule: async () => undefined,
        markProcessed: async () => undefined,
        updateDecisionOutcome: async () => undefined,
        resolveReview: async () => undefined,
        countDomainOutcomes: async () => ({ spam: 3, allow: 0 }),
        hasRule: async () => false,
      },
      mail: { moveToTrash: async () => undefined },
      telegram: {
        sendMessage: async (...args: unknown[]) => {
          sentMessages.push(args);
        },
      },
    } as unknown as ProcessDeps;

    await applyReviewDecision(deps, 10, 'spam', 'telegram');

    expect(sentMessages).toHaveLength(1);
    const [chatId, , markup] = sentMessages[0] as [
      string,
      string,
      { inline_keyboard: { callback_data: string; text: string }[][] },
    ];
    expect(chatId).toBe('777');
    const buttons = markup.inline_keyboard.flat();
    expect(buttons.find((b) => b.callback_data === 'mgdom:10:block')).toBeDefined();
    expect(buttons.find((b) => b.callback_data === 'mgdom:10:skip')).toBeDefined();
  });

  it('does not send proposal when spam count is below threshold', async () => {
    const sentMessages: unknown[][] = [];
    const deps = {
      config: {
        accounts: [account('one')],
        dryRun: false,
        telegramBotToken: 'test-token',
        telegramOwnerChatId: '777',
      },
      store: {
        getReview: async () => ({
          id: 11,
          account_slug: 'one',
          message_uid: 201,
          message_id: null,
          from_hash: 'fh',
          domain_hash: 'rare-domain',
        }),
        addRule: async () => undefined,
        markProcessed: async () => undefined,
        updateDecisionOutcome: async () => undefined,
        resolveReview: async () => undefined,
        countDomainOutcomes: async () => ({ spam: 2, allow: 0 }),
        hasRule: async () => false,
      },
      mail: { moveToTrash: async () => undefined },
      telegram: {
        sendMessage: async (...args: unknown[]) => {
          sentMessages.push(args);
        },
      },
    } as unknown as ProcessDeps;

    await applyReviewDecision(deps, 11, 'spam', 'telegram');

    expect(sentMessages).toHaveLength(0);
  });

  it('does not send proposal when domain has any allow outcomes', async () => {
    const sentMessages: unknown[][] = [];
    const deps = {
      config: {
        accounts: [account('one')],
        dryRun: false,
        telegramBotToken: 'test-token',
        telegramOwnerChatId: '777',
      },
      store: {
        getReview: async () => ({
          id: 12,
          account_slug: 'one',
          message_uid: 202,
          message_id: null,
          from_hash: 'fh',
          domain_hash: 'mixed-domain',
        }),
        addRule: async () => undefined,
        markProcessed: async () => undefined,
        updateDecisionOutcome: async () => undefined,
        resolveReview: async () => undefined,
        countDomainOutcomes: async () => ({ spam: 5, allow: 1 }),
        hasRule: async () => false,
      },
      mail: { moveToTrash: async () => undefined },
      telegram: {
        sendMessage: async (...args: unknown[]) => {
          sentMessages.push(args);
        },
      },
    } as unknown as ProcessDeps;

    await applyReviewDecision(deps, 12, 'spam', 'telegram');

    expect(sentMessages).toHaveLength(0);
  });

  it('does not send proposal when a domain block rule already exists', async () => {
    const sentMessages: unknown[][] = [];
    const deps = {
      config: {
        accounts: [account('one')],
        dryRun: false,
        telegramBotToken: 'test-token',
        telegramOwnerChatId: '777',
      },
      store: {
        getReview: async () => ({
          id: 13,
          account_slug: 'one',
          message_uid: 203,
          message_id: null,
          from_hash: 'fh',
          domain_hash: 'already-blocked-domain',
        }),
        addRule: async () => undefined,
        markProcessed: async () => undefined,
        updateDecisionOutcome: async () => undefined,
        resolveReview: async () => undefined,
        countDomainOutcomes: async () => ({ spam: 5, allow: 0 }),
        hasRule: async (_ruleType: string, scope: string) => scope === 'domain',
      },
      mail: { moveToTrash: async () => undefined },
      telegram: {
        sendMessage: async (...args: unknown[]) => {
          sentMessages.push(args);
        },
      },
    } as unknown as ProcessDeps;

    await applyReviewDecision(deps, 13, 'spam', 'telegram');

    expect(sentMessages).toHaveLength(0);
  });

  it('does not send proposal for keep or allow_sender decisions', async () => {
    const sentMessages: unknown[][] = [];
    const mkDeps = (reviewId: number, uid: number) =>
      ({
        config: {
          accounts: [account('one')],
          dryRun: false,
          telegramBotToken: 'test-token',
          telegramOwnerChatId: '777',
        },
        store: {
          getReview: async () => ({
            id: reviewId,
            account_slug: 'one',
            message_uid: uid,
            message_id: null,
            from_hash: 'fh',
            domain_hash: 'keep-domain',
          }),
          addRule: async () => undefined,
          markProcessed: async () => undefined,
          updateDecisionOutcome: async () => undefined,
          resolveReview: async () => undefined,
        },
        mail: { moveToInbox: async () => undefined },
        telegram: {
          sendMessage: async (...args: unknown[]) => {
            sentMessages.push(args);
          },
        },
      }) as unknown as ProcessDeps;

    await applyReviewDecision(mkDeps(14, 204), 14, 'keep', 'telegram');
    await applyReviewDecision(mkDeps(15, 205), 15, 'allow_sender', 'telegram');

    expect(sentMessages).toHaveLength(0);
  });
});

describe('mail guardian handleTelegramUpdates — mgdom callbacks', () => {
  it('blocks a domain when mgdom:id:block callback arrives', async () => {
    const rules: { ruleType: string; scope: string; valueHash: string }[] = [];
    const answers: string[] = [];
    const deps = {
      config: { accounts: [account('one')], dryRun: false },
      store: {
        getReviewDomainHash: async () => 'bulk-domain-hash-2',
        addRule: async (ruleType: string, scope: string, valueHash: string) => {
          rules.push({ ruleType, scope, valueHash });
        },
      },
      telegram: {
        answerCallbackQuery: async (_id: string, text: string) => {
          answers.push(text);
        },
      },
    } as unknown as ProcessDeps;

    const update = {
      update_id: 1,
      callback_query: { id: 'cq-1', data: 'mgdom:42:block', message: { chat: { id: 777 } } },
    };

    const handled = await handleTelegramUpdates(deps, [update]);

    expect(handled).toBe(1);
    expect(rules).toEqual([
      { ruleType: 'block', scope: 'domain', valueHash: 'bulk-domain-hash-2' },
    ]);
    expect(answers).toEqual(['Domain blocked.']);
  });

  it('dismisses domain proposal and answers on mgdom:id:skip callback', async () => {
    const rules: unknown[] = [];
    const answers: string[] = [];
    const deps = {
      config: { accounts: [account('one')], dryRun: false },
      store: {
        getReviewDomainHash: async () => 'skip-domain-hash-unique',
        addRule: async (...args: unknown[]) => {
          rules.push(args);
        },
      },
      telegram: {
        answerCallbackQuery: async (_id: string, text: string) => {
          answers.push(text);
        },
      },
    } as unknown as ProcessDeps;

    const update = {
      update_id: 2,
      callback_query: { id: 'cq-2', data: 'mgdom:43:skip', message: { chat: { id: 777 } } },
    };

    const handled = await handleTelegramUpdates(deps, [update]);

    expect(handled).toBe(1);
    expect(rules).toHaveLength(0);
    expect(answers).toEqual(['Domain proposal dismissed.']);
  });

  it('answers Proposal expired when review id not found for mgdom:block', async () => {
    const answers: string[] = [];
    const deps = {
      config: { accounts: [account('one')], dryRun: false },
      store: {
        getReviewDomainHash: async () => null,
        addRule: async () => undefined,
      },
      telegram: {
        answerCallbackQuery: async (_id: string, text: string) => {
          answers.push(text);
        },
      },
    } as unknown as ProcessDeps;

    const update = {
      update_id: 3,
      callback_query: { id: 'cq-3', data: 'mgdom:999:block', message: { chat: { id: 777 } } },
    };

    await handleTelegramUpdates(deps, [update]);

    expect(answers).toEqual(['Proposal expired.']);
  });
});
