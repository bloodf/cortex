import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProcessDeps } from '../src/processor.js';
import { parseRawEmail } from '../src/imap.js';
import { processMessage } from '../src/processor.js';

// Keep normal messages on the Inbox-first pending-review path while capturing
// the decoded evidence passed to each independent assessment stage.
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

const CRLF = '\r\n';

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
  model: 'gpt-4o-mini',
  fallbackModel: 'gpt-4o',
  modelTimeoutMs: 30_000,
  confidenceThreshold: 0.95,
  dryRun: false,
};

interface CapturedReview {
  summary: string;
  subject?: string;
  body?: string;
}

interface CapturedAssessment {
  text: string;
}

/**
 * Drive the real processor for one raw email and capture what the store
 * would have persisted (summary + decoded body) plus what the classifier
 * was actually asked to read. This is the regression that bit prod: the
 * pre-decode pipeline stored MIME/base64/QP garbage in `summary` and fed
 * the same garbage to the spam classifier.
 */
async function runReview(rawEmail: string): Promise<{
  review: CapturedReview;
  classify: CapturedAssessment;
  adjudicate: CapturedAssessment;
}> {
  const message = { uid: 7, ...(await parseRawEmail(rawEmail)) };
  let captured: CapturedReview | undefined;

  const deps = {
    config: { accounts: [account('one')], ...baseConfig },
    store: {
      hasProcessed: async () => false,
      findRules: async () => [],
      hasAllowRule: async () => false,
      getLatestBrief: async () => null,
      createPendingReview: async (input: CapturedReview) => {
        captured = input;
        return 1;
      },
      markProcessed: async () => undefined,
      recordDecision: async () => undefined,
    },
    mail: {},
  } as unknown as ProcessDeps;

  const result = await processMessage(deps, account('one'), message);
  expect(result).toBe('review');
  if (!captured) throw new Error('createPendingReview was not called');

  const classifyInput = classifyEmailMock.mock.calls[0]?.[1] as CapturedAssessment;
  const adjudicateInput = adjudicateEmailMock.mock.calls[0]?.[1] as CapturedAssessment;
  return { review: captured, classify: classifyInput, adjudicate: adjudicateInput };
}

function assertHumanReadable(text: string): void {
  // Negative assertions: the undecoded-MIME tells that prod stored.
  expect(text).not.toContain('=C3=');
  expect(text).not.toContain('Content-Transfer-Encoding');
  expect(text).not.toMatch(/boundary=/i);
  expect(text).not.toContain('--B1');
}

describe('mail guardian processor decode — summary + body are human-readable', () => {
  it('(a) decodes a quoted-printable text/plain part of multipart/alternative', async () => {
    const raw = [
      'From: Café Owner <owner@example.com>',
      'Subject: Votre café est prêt',
      'Content-Type: multipart/alternative; boundary="B1"',
      '',
      '--B1',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'Bonjour, votre caf=C3=A9 co=C3=BBte =E2=82=AC10 et il est pr=C3=AAt.',
      '--B1',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>ignored html</p>',
      '--B1--',
      '',
    ].join(CRLF);

    const { review, classify, adjudicate } = await runReview(raw);

    // Decoded accented chars present in both the stored body and the summary.
    expect(review.body).toContain('café');
    expect(review.body).toContain('coûte €10');
    expect(review.body).toContain('prêt');
    expect(review.summary).toContain('café');
    expect(review.summary).toContain('prêt');
    assertHumanReadable(review.summary);
    assertHumanReadable(review.body ?? '');

    // The classifier read the decoded body, not raw QP.
    expect(classify.text).toContain('café');
    expect(adjudicate.text).toContain('café');
    assertHumanReadable(classify.text);
    assertHumanReadable(adjudicate.text);
  });

  it('(b) decodes a base64-encoded text/plain part', async () => {
    const plain = 'Hello,\n\nYour invoice #4821 is ready for payment.\n';
    const b64 = Buffer.from(plain, 'utf8').toString('base64');
    const raw = [
      'From: Billing <billing@example.com>',
      'Subject: Invoice ready',
      'Content-Type: multipart/alternative; boundary="B1"',
      '',
      '--B1',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      b64,
      '--B1--',
      '',
    ].join(CRLF);

    const { review, classify, adjudicate } = await runReview(raw);
    expect(review.body).toContain('Your invoice #4821 is ready for payment.');
    expect(review.summary).toContain('invoice');
    expect(review.summary).toContain('ready');
    // The raw base64 blob must NOT survive into the summary or body.
    expect(review.summary).not.toContain(b64);
    expect(review.body).not.toContain(b64);
    assertHumanReadable(review.summary);
    assertHumanReadable(review.body ?? '');

    expect(classify.text).toContain('invoice');
    expect(adjudicate.text).toContain('invoice');
    expect(classify.text).not.toContain(b64);
    expect(adjudicate.text).not.toContain(b64);
  });
  it('(c) leaves a plain 7bit body unchanged (control)', async () => {
    const raw = [
      'From: Friend <friend@good.test>',
      'Subject: Lunch tomorrow',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Hey, are we still on for lunch tomorrow at noon?',
      '',
    ].join(CRLF);

    const { review, classify, adjudicate } = await runReview(raw);
    expect(review.body).toContain('lunch tomorrow at noon');
    expect(review.summary).toContain('lunch');
    expect(classify.text).toContain('lunch tomorrow at noon');
    expect(adjudicate.text).toContain('lunch tomorrow at noon');
    assertHumanReadable(review.summary);
    assertHumanReadable(review.body ?? '');
  });
});

describe('mail guardian processor — authentication evidence and Inbox-first reviews', () => {
  it('passes bounded parsed authentication and mailing-list evidence to both AI stages', async () => {
    const raw = [
      'From: Stripe <billing@stripe.com>',
      'Reply-To: support@stripe.com',
      'Return-Path: <bounce@stripe.com>',
      'Subject: Your invoice is ready',
      'Authentication-Results: mx.example.com; spf=pass smtp.mailfrom=stripe.com; dkim=pass header.d=stripe.com',
      'Received-SPF: pass (mx.example.com: domain of stripe.com)',
      'DKIM-Signature: v=1; a=rsa-sha256; d=stripe.com; s=selector1; h=from:subject; bh=...; b=...',
      'List-ID: stripe-billing.list-id.stripe.com',
      'List-Unsubscribe: <mailto:unsub@stripe.com>',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Your invoice #4821 is ready for payment.',
    ].join(CRLF);

    const { classify, adjudicate } = await runReview(raw);

    expect(classify.replyTo).toBe('support@stripe.com');
    expect(classify.returnPath).toBe('<bounce@stripe.com>');
    expect(classify.authenticationResults).toContain('spf=pass');
    expect(classify.receivedSpf).toContain('pass (mx.example.com');
    expect(classify.dkimSigningDomain).toBe('stripe.com');
    expect(classify.listId).toBe('stripe-billing.list-id.stripe.com');
    expect(classify.hasListUnsubscribe).toBe(true);
    expect(adjudicate).toMatchObject(classify);
  });

  it('persists non-trash review evidence with Inbox as its source and never moves mail to review', async () => {
    const message = {
      uid: 91,
      ...(await parseRawEmail(
        [
          'From: Friend <friend@good.test>',
          'Subject: lunch',
          'Content-Type: text/plain; charset=utf-8',
          '',
          'Are we still on for lunch tomorrow?',
        ].join(CRLF),
      )),
    };
    const reviewInputs: unknown[] = [];
    const moveToReview = vi.fn(async () => 'INBOX.Cortex Mail Guardian Review');
    const deps = {
      config: { accounts: [account('one')], ...baseConfig },
      store: {
        hasProcessed: async () => false,
        findRules: async () => [],
        hasAllowRule: async () => false,
        getLatestBrief: async () => null,
        createPendingReview: async (input: unknown) => {
          reviewInputs.push(input);
          return 501;
        },
        markProcessed: async () => undefined,
        recordDecision: async () => undefined,
      },
      mail: { moveToReview },
      telegram: { sendMessage: async () => undefined },
    } as unknown as ProcessDeps;

    await expect(processMessage(deps, account('one'), message)).resolves.toBe('review');
    expect(moveToReview).not.toHaveBeenCalled();
    expect(reviewInputs[0]).toMatchObject({
      sourceMailbox: 'inbox',
      spamScore: 50,
      category: 'suspicious',
      senderLegitimacy: 'unknown',
    });
  });
});
