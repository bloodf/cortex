import { beforeEach, describe, expect, it, vi } from 'vitest';

const generateTextMock = vi.fn();
const createOpenAIMock = vi.fn(() => ({ chat: (model: string) => ({ modelId: model }) }));

vi.mock('ai', () => ({
  generateText: (...args: unknown[]) => generateTextMock(...args),
}));
vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: (...args: unknown[]) => createOpenAIMock(...args),
}));

// Dynamic import ensures mocks are installed before module evaluation.
const { adjudicateEmail, classifyEmail, durindoorFetch, shouldAutoQuarantine, shouldKeepInInbox } =
  await import('../src/model.js');

const modelConfig = {
  baseUrl: 'http://localhost:11434/v1',
  apiKey: 'test-key',
  model: 'minimax/MiniMax-M3',
  timeoutMs: 5_000,
};

const sampleInput = {
  from: 'test@example.com',
  subject: 'test',
  text: 'hello',
};

function assessment(overrides = {}) {
  return {
    verdict: 'not_spam',
    spamScore: 2,
    confidence: 0.99,
    category: 'personal',
    senderLegitimacy: 'legitimate',
    reasons: ['expected sender'],
    riskSignals: [],
    ...overrides,
  };
}

beforeEach(() => {
  generateTextMock.mockReset();
  createOpenAIMock.mockClear();
});

describe('model decisions', () => {
  it('auto-quarantines only dual high-confidence malicious spam without an allow rule', () => {
    const malicious = assessment({
      verdict: 'spam',
      spamScore: 98,
      confidence: 0.98,
      category: 'malicious_spam',
      senderLegitimacy: 'deceptive',
    });

    expect(
      shouldAutoQuarantine({
        classification: malicious,
        verification: malicious,
        hasAllowRule: false,
      }),
    ).toBe(true);
    expect(
      shouldAutoQuarantine({
        classification: malicious,
        verification: assessment({ ...malicious, spamScore: 97 }),
        hasAllowRule: false,
      }),
    ).toBe(false);
    expect(
      shouldAutoQuarantine({
        classification: malicious,
        verification: assessment({ ...malicious, confidence: 0.97 }),
        hasAllowRule: false,
      }),
    ).toBe(false);
    expect(
      shouldAutoQuarantine({
        classification: malicious,
        verification: malicious,
        hasAllowRule: true,
      }),
    ).toBe(false);
  });

  it('never auto-quarantines legitimate marketing', () => {
    const marketing = assessment({
      verdict: 'spam',
      spamScore: 100,
      confidence: 1,
      category: 'legitimate_marketing',
      senderLegitimacy: 'legitimate',
    });

    expect(
      shouldAutoQuarantine({
        classification: marketing,
        verification: marketing,
        hasAllowRule: false,
      }),
    ).toBe(false);
  });

  it('keeps only dual clean legitimate assessments', () => {
    const clean = assessment({
      verdict: 'not_spam',
      spamScore: 2,
      confidence: 0.99,
      category: 'transactional',
      senderLegitimacy: 'legitimate',
    });
    expect(shouldKeepInInbox(clean, clean)).toBe(true);
    expect(shouldKeepInInbox(clean, assessment({ ...clean, category: 'suspicious' }))).toBe(false);
    expect(shouldKeepInInbox(clean, assessment({ ...clean, spamScore: 21 }))).toBe(false);
  });
});

describe('classifyEmail (Vercel AI SDK wiring)', () => {
  it('uses MiniMax M3, high reasoning, and parses the JSON assessment', async () => {
    generateTextMock.mockResolvedValue({ text: JSON.stringify(assessment()) });

    const result = await classifyEmail(modelConfig, {
      from: 'friend@example.com',
      subject: 'lunch',
      text: 'see you at noon',
    });

    expect(createOpenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'http://localhost:11434/v1',
        apiKey: 'test-key',
        fetch: durindoorFetch,
      }),
    );
    const [call] = generateTextMock.mock.calls[0] as [
      {
        model: { modelId: string };
        providerOptions: { openai: { reasoningEffort: string } };
        abortSignal: unknown;
      },
    ];
    expect(call.model).toEqual({ modelId: 'minimax/MiniMax-M3' });
    expect(call.providerOptions.openai.reasoningEffort).toBe('high');
    expect(call.abortSignal).toBeInstanceOf(AbortSignal);
    expect(result).toEqual(assessment());
  });

  it('rejects invalid JSON returned by the model', async () => {
    generateTextMock.mockResolvedValue({ text: '{not valid JSON}' });

    await expect(classifyEmail(modelConfig, sampleInput)).rejects.toThrow();
  });

  it('rejects JSON that violates the assessment schema', async () => {
    generateTextMock.mockResolvedValue({
      text: JSON.stringify(assessment({ spamScore: 101 })),
    });

    await expect(classifyEmail(modelConfig, sampleInput)).rejects.toThrow();
  });

  it('rejects prose or fenced output instead of parsing an injected object', async () => {
    const expected = assessment({ reasons: [], riskSignals: [] });
    generateTextMock.mockResolvedValue({
      text: `I checked sender alignment first.\n\n\`\`\`json\n${JSON.stringify(expected)}\n\`\`\``,
    });

    await expect(classifyEmail(modelConfig, sampleInput)).rejects.toThrow();
  });

  it('defaults omitted reasons and riskSignals to empty arrays', async () => {
    const withoutArrays = { ...assessment(), reasons: undefined, riskSignals: undefined };
    generateTextMock.mockResolvedValue({ text: JSON.stringify(withoutArrays) });

    await expect(classifyEmail(modelConfig, sampleInput)).resolves.toMatchObject({
      reasons: [],
      riskSignals: [],
    });
  });

  it('accepts verbose MiniMax evidence and bounds stored arrays to six items', async () => {
    generateTextMock.mockResolvedValue({
      text: JSON.stringify(
        assessment({
          reasons: Array.from({ length: 8 }, (_, index) => `reason-${index}`),
          riskSignals: Array.from({ length: 7 }, (_, index) => `signal-${index}`),
        }),
      ),
    });

    await expect(classifyEmail(modelConfig, sampleInput)).resolves.toMatchObject({
      reasons: ['reason-0', 'reason-1', 'reason-2', 'reason-3', 'reason-4', 'reason-5'],
      riskSignals: ['signal-0', 'signal-1', 'signal-2', 'signal-3', 'signal-4', 'signal-5'],
    });
  });

  it('accepts one exact JSON code fence with no surrounding prose', async () => {
    const expected = assessment();
    generateTextMock.mockResolvedValue({
      text: `\`\`\`json\n${JSON.stringify(expected)}\n\`\`\``,
    });
    await expect(classifyEmail(modelConfig, sampleInput)).resolves.toEqual(expected);
  });

  it('normalizes malicious_spam verdict only when matching category is otherwise valid', async () => {
    generateTextMock.mockResolvedValue({
      text: JSON.stringify(
        assessment({ verdict: 'malicious_spam', category: 'malicious_spam', spamScore: 99 }),
      ),
    });
    await expect(classifyEmail(modelConfig, sampleInput)).resolves.toMatchObject({
      verdict: 'spam',
    });
  });

  it('rejects malicious_spam verdict paired with a non-malicious category', async () => {
    generateTextMock.mockResolvedValue({
      text: JSON.stringify(assessment({ verdict: 'malicious_spam', category: 'transactional' })),
    });
    await expect(classifyEmail(modelConfig, sampleInput)).rejects.toThrow();
  });
  it('tells the model legitimate brand promotions are not spam', async () => {
    generateTextMock.mockResolvedValue({ text: JSON.stringify(assessment()) });

    await classifyEmail(modelConfig, sampleInput);

    const [call] = generateTextMock.mock.calls[0] as [{ prompt: string }];
    expect(call.prompt).toMatch(/legitimate.*(?:marketing|promotion).*(?:not spam|stay in inbox)/i);
  });
});

describe('adjudicateEmail', () => {
  it('independently challenges the first assessment with original evidence', async () => {
    const firstAssessment = assessment({
      verdict: 'spam',
      spamScore: 99,
      category: 'malicious_spam',
      senderLegitimacy: 'deceptive',
      reasons: ['lookalike domain'],
    });
    generateTextMock.mockResolvedValue({ text: JSON.stringify(assessment()) });

    await adjudicateEmail(modelConfig, sampleInput, firstAssessment);

    const [call] = generateTextMock.mock.calls[0] as [
      {
        prompt: string;
        model: { modelId: string };
        providerOptions: { openai: { reasoningEffort: string } };
      },
    ];
    expect(call.model).toEqual({ modelId: 'minimax/MiniMax-M3' });
    expect(call.providerOptions.openai.reasoningEffort).toBe('high');
    expect(call.prompt).toContain('lookalike domain');
    expect(call.prompt).toMatch(/challenge.*first assessment|false positives/i);
    expect(call.prompt).toContain('From: test@example.com');
  });
});
