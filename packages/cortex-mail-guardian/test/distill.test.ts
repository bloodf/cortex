import { beforeEach, describe, expect, it, vi } from 'vitest';

const generateTextMock = vi.fn();
const createOpenAIMock = vi.fn(() => ({ chat: (model: string) => ({ modelId: model }) }));

vi.mock('ai', () => ({
  generateText: (...args: unknown[]) => generateTextMock(...args),
}));
vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: (...args: unknown[]) => createOpenAIMock(...args),
}));

const { distillBrief } = await import('../src/distill.js');
const { durindoorFetch } = await import('../src/model.js');

beforeEach(() => {
  generateTextMock.mockReset();
  createOpenAIMock.mockClear();
});

const config = {
  model: 'minimax/MiniMax-M3',
  openAiBaseUrl: 'http://localhost:11434/v1',
  openAiApiKey: 'test-key',
  dryRun: false,
  accounts: [],
};

function makeDecision(verdict: string, outcome: string, summary: string) {
  return {
    account_slug: 'acc',
    message_uid: 1,
    from_hash: 'fh',
    domain_hash: 'dh',
    summary,
    verdict,
    outcome,
    created_at: new Date(),
  };
}

describe('distillBrief', () => {
  it('skips model call and insert when no decisions exist', async () => {
    const listRecentDecisions = vi.fn(async () => []);
    const insertBrief = vi.fn(async () => undefined);
    const store = { listRecentDecisions, insertBrief };

    const result = await distillBrief({ config: config as never, store });

    expect(generateTextMock).not.toHaveBeenCalled();
    expect(insertBrief).not.toHaveBeenCalled();
    expect(result).toMatchObject({ skipped: true, sourceDecisions: 0 });
  });

  it('reads ≤200 owner-confirmed decisions from the store', async () => {
    generateTextMock.mockResolvedValueOnce({ text: 'brief text' });
    const decisions = [makeDecision('spam', 'owner_spam', 'bulk marketing email')];
    const listRecentDecisions = vi.fn(async () => decisions);
    const insertBrief = vi.fn(async () => undefined);
    const store = { listRecentDecisions, insertBrief };

    await distillBrief({ config: config as never, store });

    expect(listRecentDecisions).toHaveBeenCalledWith(200);
  });

  it('sends a prompt containing redacted summaries and marks disagreements', async () => {
    generateTextMock.mockResolvedValueOnce({ text: 'owner brief' });
    const decisions = [
      makeDecision('spam', 'owner_keep', 'monthly bank statement'),
      makeDecision('not_spam', 'owner_spam', 'cold sales pitch'),
    ];
    const listRecentDecisions = vi.fn(async () => decisions);
    const insertBrief = vi.fn(async () => undefined);
    const store = { listRecentDecisions, insertBrief };

    await distillBrief({ config: config as never, store });

    expect(generateTextMock).toHaveBeenCalledOnce();
    const [opts] = generateTextMock.mock.calls[0] as [
      {
        prompt: string;
        model: { modelId: string };
        providerOptions: { openai: { reasoningEffort: string } };
      },
    ];
    expect(opts.prompt).toContain('monthly bank statement');
    expect(opts.prompt).toContain('cold sales pitch');
    expect(opts.prompt).toContain('DISAGREEMENT');
    expect(opts.model).toEqual({ modelId: 'minimax/MiniMax-M3' });
    expect(opts.providerOptions.openai.reasoningEffort).toBe('high');
    expect(createOpenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({ fetch: durindoorFetch }),
    );
  });

  it('persists the brief with source_decisions equal to row count', async () => {
    generateTextMock.mockResolvedValueOnce({ text: 'owner summary' });
    const decisions = [
      makeDecision('spam', 'owner_spam', 'crypto ad'),
      makeDecision('spam', 'owner_spam', 'investment pitch'),
    ];
    const listRecentDecisions = vi.fn(async () => decisions);
    const insertBrief = vi.fn(async () => undefined);
    const store = { listRecentDecisions, insertBrief };

    await distillBrief({ config: config as never, store });

    expect(insertBrief).toHaveBeenCalledWith('owner summary', 2);
  });

  it('truncates brief to 1500 chars before insert', async () => {
    const longText = 'x'.repeat(2000);
    generateTextMock.mockResolvedValueOnce({ text: longText });
    const decisions = [makeDecision('spam', 'owner_spam', 'ad email')];
    const listRecentDecisions = vi.fn(async () => decisions);
    const insertBrief = vi.fn(async () => undefined);
    const store = { listRecentDecisions, insertBrief };

    await distillBrief({ config: config as never, store });

    const [briefArg] = insertBrief.mock.calls[0] as [string, number];
    expect(briefArg.length).toBe(1500);
  });

  it('returns sourceDecisions and briefChars', async () => {
    generateTextMock.mockResolvedValueOnce({ text: 'hello world' });
    const decisions = [makeDecision('not_spam', 'owner_spam', 'phishing')];
    const listRecentDecisions = vi.fn(async () => decisions);
    const insertBrief = vi.fn(async () => undefined);
    const store = { listRecentDecisions, insertBrief };

    const result = await distillBrief({ config: config as never, store });

    expect(result).toMatchObject({ sourceDecisions: 1, briefChars: 11 });
  });
});
