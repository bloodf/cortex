import type { MailAccountConfig } from './config.js';
import type { MailMessage } from './imap.js';
import type { AssessmentInput, MailAssessment } from './model.js';
import runSequentially from './sequential.js';

export interface ReconcileReview {
  id: number;
  accountSlug: string;
  messageUid: number;
  messageId: string | null;
  fromHash: string;
  domainHash: string;
  sourceMailbox: 'inbox' | 'review';
}

interface ReconcileMail {
  fetchByMessageId(
    account: MailAccountConfig,
    mailbox: string,
    messageId: string,
  ): Promise<MailMessage | undefined>;
}

export interface ReconcileDeps {
  accounts: Map<string, MailAccountConfig>;
  mail: ReconcileMail;
  hasAllowRule(fromHash: string, domainHash: string): Promise<boolean>;
  classify(input: AssessmentInput): Promise<MailAssessment>;
  adjudicate(input: AssessmentInput, first: MailAssessment): Promise<MailAssessment>;
  shouldTrash(input: {
    classification: MailAssessment;
    verification: MailAssessment;
    hasAllowRule: boolean;
  }): boolean;
}

export interface ReconcileOptions {
  limit: number;
  offset: number;
  ids?: number[];
}

export interface ReconcileRecommendation {
  reviewId: number;
  action: 'keep_review' | 'trash' | 'failed';
  spamScore?: number;
  verifySpamScore?: number;
  category?: string;
  error?: string;
}

export interface ReconcileResult {
  summary: { examined: number; keepReview: number; wouldTrash: number; failed: number };
  recommendations: ReconcileRecommendation[];
}

export function parseReconcileArgs(argv: string[]): ReconcileOptions {
  if (argv.includes('--execute')) {
    throw new Error('reconcile is read-only; --execute is unavailable');
  }
  const limitIndex = argv.indexOf('--limit');
  const offsetIndex = argv.indexOf('--offset');
  const idsIndex = argv.indexOf('--ids');
  const parsedIds = idsIndex < 0 ? undefined : argv[idsIndex + 1]?.split(',').map(Number);
  const ids = parsedIds ? [...new Set(parsedIds)] : undefined;
  const limit = limitIndex < 0 ? (ids?.length ?? 10) : Number(argv[limitIndex + 1]);
  const offset = offsetIndex < 0 ? 0 : Number(argv[offsetIndex + 1]);
  if (!Number.isInteger(limit) || limit <= 0 || limit > 100) {
    throw new Error('--limit must be an integer between 1 and 100');
  }
  if (!Number.isInteger(offset) || offset < 0 || offset > 10_000) {
    throw new Error('--offset must be an integer between 0 and 10000');
  }
  if (
    parsedIds &&
    (parsedIds.length < 1 ||
      parsedIds.length > 100 ||
      parsedIds.some((id) => !Number.isInteger(id) || id <= 0))
  ) {
    throw new Error('--ids must contain 1 to 100 positive integer IDs');
  }
  if (ids && (limitIndex >= 0 || offsetIndex >= 0)) {
    throw new Error('--ids cannot be combined with --limit or --offset');
  }
  const known = new Set([
    ...(limitIndex < 0 ? [] : ['--limit', argv[limitIndex + 1]]),
    ...(offsetIndex < 0 ? [] : ['--offset', argv[offsetIndex + 1]]),
    ...(idsIndex < 0 ? [] : ['--ids', argv[idsIndex + 1]]),
  ]);
  const unknown = argv.find((arg) => !known.has(arg));
  if (unknown) throw new Error(`unknown reconcile option: ${unknown}`);
  return { limit, offset, ...(ids ? { ids } : {}) };
}

function assessmentInput(message: MailMessage): AssessmentInput {
  return {
    from: message.from,
    subject: message.subject,
    text: message.bodyText ?? message.text,
    replyTo: message.replyTo,
    returnPath: message.returnPath,
    authenticationResults: message.authenticationResults,
    receivedSpf: message.receivedSpf,
    dkimSigningDomain: message.dkimSigningDomain,
    listId: message.listId,
    hasListUnsubscribe: message.hasListUnsubscribe,
  };
}

export async function reconcileReviews(
  deps: ReconcileDeps,
  reviews: ReconcileReview[],
  options: ReconcileOptions,
): Promise<ReconcileResult> {
  const selected = reviews.slice(0, options.limit);
  const result: ReconcileResult = {
    summary: { examined: 0, keepReview: 0, wouldTrash: 0, failed: 0 },
    recommendations: [],
  };
  await runSequentially(selected, async (review) => {
    result.summary.examined += 1;
    try {
      const account = deps.accounts.get(review.accountSlug);
      if (!account) throw new Error('account not configured');
      const mailbox = review.sourceMailbox === 'inbox' ? account.inbox : account.reviewMailbox;
      if (!review.messageId) throw new Error('message has no Message-ID');
      const message = await deps.mail.fetchByMessageId(account, mailbox, review.messageId);
      if (!message) throw new Error('message not found');
      const input = assessmentInput(message);
      const classification = await deps.classify(input);
      const verification = await deps.adjudicate(input, classification);
      const trash = deps.shouldTrash({
        classification,
        verification,
        hasAllowRule: await deps.hasAllowRule(review.fromHash, review.domainHash),
      });
      if (trash) result.summary.wouldTrash += 1;
      else result.summary.keepReview += 1;
      result.recommendations.push({
        reviewId: review.id,
        action: trash ? 'trash' : 'keep_review',
        spamScore: classification.spamScore,
        verifySpamScore: verification.spamScore,
        category: classification.category,
      });
    } catch (error) {
      result.summary.failed += 1;
      result.recommendations.push({
        reviewId: review.id,
        action: 'failed',
        error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
      });
    }
  });
  return result;
}
