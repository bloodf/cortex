import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';
import { durindoorFetch } from './model.js';
import type { GuardianConfig } from './config.js';
import type { DecisionRow } from './store.js';

export interface DistillStore {
  listRecentDecisions(limit: number): Promise<DecisionRow[]>;
  insertBrief(brief: string, sourceDecisions: number): Promise<void>;
}

export interface DistillDeps {
  config: GuardianConfig;
  store: DistillStore;
}

export interface DistillResult {
  sourceDecisions: number;
  briefChars: number;
  skipped?: true;
}

const BRIEF_MAX_CHARS = 1500;
const MAX_DECISIONS = 200;

export async function distillBrief(deps: DistillDeps): Promise<DistillResult> {
  const decisions = await deps.store.listRecentDecisions(MAX_DECISIONS);
  if (decisions.length === 0) {
    process.stdout.write('mail-guardian-distill: no owner decisions to distill, skipping\n');
    return { sourceDecisions: 0, briefChars: 0, skipped: true };
  }

  const lines = decisions.map((d) => {
    const disagreement =
      (d.verdict === 'spam' && (d.outcome === 'owner_keep' || d.outcome === 'owner_allow')) ||
      (d.verdict === 'not_spam' && (d.outcome === 'owner_spam' || d.outcome === 'owner_block'));
    return `[${disagreement ? 'DISAGREEMENT' : 'AGREEMENT'}] model=${d.verdict ?? 'null'} owner=${d.outcome} summary="${d.summary}"`;
  });

  const openai = createOpenAI({
    baseURL: deps.config.openAiBaseUrl.replace(/\/+$/, ''),
    apiKey: deps.config.openAiApiKey,
    fetch: durindoorFetch,
  });

  const prompt = [
    'Build a concise owner-preference brief for a personal spam guardian.',
    'Legitimate brands and their authentic promotions are kept; spam means malicious, deceptive, impersonating, fabricated, or obvious junk mail.',
    'Based on these owner-confirmed decisions (DISAGREEMENT = model verdict was wrong), summarise in ≤300 words:',
    '• What the owner keeps (personal, transactional, legitimate brand, and marketing categories)',
    '• What the owner trashes (malicious/deceptive spam patterns)',
    '• Notable disagreements with the model',
    'Use only the redacted summaries below. Output the brief text only.',
    '',
    lines.join('\n'),
  ].join('\n');

  const { text } = await generateText({
    // .chat() forces /v1/chat/completions — DurinDoor's /v1/responses endpoint
    // always streams SSE, which the ai-sdk non-streaming client can't parse.
    model: openai.chat(deps.config.model),
    prompt,
    providerOptions: { openai: { reasoningEffort: 'high' } },
    abortSignal: AbortSignal.timeout(120_000),
  });

  const brief = text.slice(0, BRIEF_MAX_CHARS);
  await deps.store.insertBrief(brief, decisions.length);
  return { sourceDecisions: decisions.length, briefChars: brief.length };
}
