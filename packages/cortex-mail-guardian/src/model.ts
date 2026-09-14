import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';
import { z } from 'zod';

export type SpamVerdict = 'spam' | 'not_spam' | 'uncertain';
export type MailCategory =
  | 'personal'
  | 'transactional'
  | 'legitimate_marketing'
  | 'suspicious'
  | 'malicious_spam';

export interface MailAssessment {
  verdict: SpamVerdict;
  spamScore: number;
  confidence: number;
  category: MailCategory;
  senderLegitimacy: 'legitimate' | 'unknown' | 'deceptive';
  reasons: string[];
  riskSignals: string[];
}

export interface ModelClientConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
}

export const classificationSchema = z.object({
  verdict: z.enum(['spam', 'not_spam', 'uncertain']),
  spamScore: z.number().int().min(0).max(100),
  confidence: z.number().min(0).max(1),
  category: z.enum([
    'personal',
    'transactional',
    'legitimate_marketing',
    'suspicious',
    'malicious_spam',
  ]),
  senderLegitimacy: z.enum(['legitimate', 'unknown', 'deceptive']),
  reasons: z.array(z.string()).default([]),
  riskSignals: z.array(z.string()).default([]),
});

/**
 * DurinDoor quirk: when a chat-completions request omits `stream`, the router
 * takes its forced-SSE path and leaks a trailing `data: [DONE]` after the JSON
 * body, which strict clients (ai-sdk) fail to parse. The ai-sdk never sets
 * `stream` for non-streaming calls, so inject `stream: false` explicitly.
 */
export const durindoorFetch: typeof fetch = (url, init) => {
  let requestInit = init;
  if (init?.body && typeof init.body === 'string') {
    try {
      const body = JSON.parse(init.body);
      if (body && typeof body === 'object' && !Array.isArray(body) && body.stream === undefined) {
        body.stream = false;
        requestInit = { ...init, body: JSON.stringify(body) };
      }
    } catch {
      // non-JSON body: leave untouched
    }
  }
  return fetch(url, requestInit);
};

export interface AssessmentInput {
  from: string;
  subject: string;
  text: string;
  feedbackSummary?: string;
  replyTo?: string;
  returnPath?: string;
  authenticationResults?: string;
  receivedSpf?: string;
  dkimSigningDomain?: string;
  listId?: string;
  hasListUnsubscribe?: boolean;
}

function evidence(input: AssessmentInput): string[] {
  return [
    `From: ${input.from}`,
    `Subject: ${input.subject}`,
    input.replyTo ? `Reply-To: ${input.replyTo}` : '',
    input.returnPath ? `Return-Path: ${input.returnPath}` : '',
    input.authenticationResults ? `Authentication-Results: ${input.authenticationResults}` : '',
    input.receivedSpf ? `Received-SPF: ${input.receivedSpf}` : '',
    input.dkimSigningDomain ? `DKIM signing domain: ${input.dkimSigningDomain}` : '',
    input.listId ? `List-ID: ${input.listId}` : '',
    input.hasListUnsubscribe === undefined
      ? ''
      : `List-Unsubscribe present: ${input.hasListUnsubscribe}`,
    `Body:\n${input.text.slice(0, 60_000)}`,
  ].filter(Boolean);
}

function jsonContract(): string {
  return [
    'Return only a JSON object with no Markdown or commentary.',
    'Schema: {"verdict":"spam|not_spam|uncertain","spamScore":integer 0..100,"confidence":number 0..1,"category":"personal|transactional|legitimate_marketing|suspicious|malicious_spam","senderLegitimacy":"legitimate|unknown|deceptive","reasons":string[],"riskSignals":string[]}.',
  ].join('\n');
}

function buildAnalysisPrompt(input: AssessmentInput): string {
  return [
    'Assess this email for a personal mail guardian. Analyze sender and domain alignment, supplied authentication evidence, mailing-list markers, content, and owner feedback.',
    'Legitimate brand marketing and promotions are not spam and must stay in Inbox. Authentic transactional mail, login codes, invoices, receipts, renewals, and security notices are not spam.',
    'Only malicious, deceptive, impersonating, fabricated, or obvious junk mail should receive a high spam score. Tracking links, promotional language, or unsubscribe headers alone are not spam evidence when sender is authentic.',
    jsonContract(),
    input.feedbackSummary ? `Prior owner feedback summary:\n${input.feedbackSummary}` : '',
    ...evidence(input),
  ]
    .filter(Boolean)
    .join('\n\n');
}

function buildAdjudicationPrompt(input: AssessmentInput, firstAssessment: MailAssessment): string {
  return [
    'Independently adjudicate this email. Challenge the first assessment and actively look for false positives. Verify brand and domain authenticity signals from the original evidence. Do not copy the first answer mechanically; produce a fresh assessment.',
    'Legitimate brand marketing and promotions are not spam and must stay in Inbox. Authentication, transaction, and mailing-list evidence can outweigh promotional language.',
    `First assessment to challenge:\n${JSON.stringify(firstAssessment)}`,
    jsonContract(),
    ...evidence(input),
  ].join('\n\n');
}

function parseAssessment(text: string): MailAssessment {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  const parsed: unknown = JSON.parse(fenced?.[1] ?? trimmed);
  if (
    parsed &&
    typeof parsed === 'object' &&
    'verdict' in parsed &&
    'category' in parsed &&
    parsed.verdict === 'malicious_spam'
  ) {
    if (parsed.category !== 'malicious_spam') {
      throw new Error('malicious_spam verdict requires malicious_spam category');
    }
    parsed.verdict = 'spam';
  }
  const assessment = classificationSchema.parse(parsed);
  return {
    ...assessment,
    reasons: assessment.reasons.slice(0, 6),
    riskSignals: assessment.riskSignals.slice(0, 6),
  };
}

async function assess(config: ModelClientConfig, prompt: string): Promise<MailAssessment> {
  const openai = createOpenAI({
    baseURL: config.baseUrl.replace(/\/+$/, ''),
    apiKey: config.apiKey,
    fetch: durindoorFetch,
  });
  const { text } = await generateText({
    // .chat() forces /v1/chat/completions, avoiding DurinDoor's forced-SSE responses path.
    model: openai.chat(config.model),
    prompt,
    providerOptions: { openai: { reasoningEffort: 'high' } },
    abortSignal: AbortSignal.timeout(config.timeoutMs ?? 30_000),
  });
  return parseAssessment(text);
}

export async function classifyEmail(
  config: ModelClientConfig,
  input: AssessmentInput,
): Promise<MailAssessment> {
  return assess(config, buildAnalysisPrompt(input));
}

export async function adjudicateEmail(
  config: ModelClientConfig,
  input: AssessmentInput,
  firstAssessment: MailAssessment,
): Promise<MailAssessment> {
  return assess(config, buildAdjudicationPrompt(input, firstAssessment));
}

export function shouldKeepInInbox(
  classification: MailAssessment,
  verification: MailAssessment,
): boolean {
  const isClean = (assessment: MailAssessment) =>
    assessment.verdict === 'not_spam' &&
    assessment.spamScore <= 20 &&
    assessment.confidence >= 0.8 &&
    assessment.category !== 'suspicious' &&
    assessment.category !== 'malicious_spam' &&
    assessment.senderLegitimacy === 'legitimate';
  return isClean(classification) && isClean(verification);
}

export function shouldAutoQuarantine(input: {
  classification: MailAssessment;
  verification: MailAssessment;
  hasAllowRule: boolean;
}): boolean {
  const isMalicious = (assessment: MailAssessment) =>
    assessment.verdict === 'spam' &&
    assessment.category === 'malicious_spam' &&
    assessment.spamScore >= 98 &&
    assessment.confidence >= 0.98 &&
    (assessment.senderLegitimacy === 'deceptive' || assessment.riskSignals.length > 0);

  return (
    !input.hasAllowRule && isMalicious(input.classification) && isMalicious(input.verification)
  );
}
