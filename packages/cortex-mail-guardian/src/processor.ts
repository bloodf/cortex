import type { GuardianConfig, MailAccountConfig } from './config.js';
import { telegramEnabled } from './config.js';
import type { MailClient, MailMessage } from './imap.js';
import type { GuardianStore } from './store.js';
import type { TelegramClient, TelegramUpdate } from './telegram.js';

import {
  adjudicateEmail,
  classifyEmail,
  shouldAutoQuarantine,
  shouldKeepInInbox,
  type MailAssessment,
} from './model.js';
import { redactEmail } from './redact.js';
import { evaluateRules } from './rules.js';
import runSequentially, { STOP } from './sequential.js';

const DOMAIN_BLOCK_THRESHOLD = 3;
/** Open-review backlog above this many rows emits a WARNING each sweep. */
export const OPEN_REVIEW_BACKLOG_THRESHOLD = 100;
const skippedDomains = new Set<string>();

export interface ProcessDeps {
  config: GuardianConfig;
  mail: MailClient;
  store: GuardianStore;
  telegram: TelegramClient;
}

export function buildReviewMessage(input: {
  accountAddress: string;
  from: string;
  subject: string;
  verdict: string;
  confidence: number;
  reviewId: number;
}): string {
  return [
    '📬 Cortex mail guardian needs a decision.',
    `Account: ${input.accountAddress}`,
    `From: ${input.from || '(unknown sender)'}`,
    `Subject: ${input.subject || '(no subject)'}`,
    `Verdict: ${input.verdict} (${input.confidence})`,
    'Status: moved to the review folder while waiting.',
    '',
    'Reply to Cortex with one of:',
    `mail guardian decide ${input.reviewId} spam`,
    `mail guardian decide ${input.reviewId} keep`,
    `mail guardian decide ${input.reviewId} block_sender`,
    `mail guardian decide ${input.reviewId} allow_sender`,
  ].join('\n');
}

export async function processMessage(
  deps: ProcessDeps,
  account: MailAccountConfig,
  message: MailMessage,
): Promise<'review' | 'kept' | 'skipped' | 'trashed'> {
  if (await deps.store.hasProcessed(account.slug, message.uid)) return 'skipped';
  const redacted = redactEmail({
    from: message.from,
    subject: message.subject,
    // Use the decoded body (multipart/base64/QP unwrapped) so the redacted
    // summary is human-readable; fall back to raw text only when undecoded.
    text: message.bodyText ?? message.text,
  });

  // Deterministic rule pre-filter — runs BEFORE any AI/model call.
  // A deny (block) rule short-circuits to spam (trash); an allow rule to ham (keep).
  const ruleMatch = await evaluateRules(deps.store, redacted);
  if (ruleMatch) {
    if (ruleMatch.verdict === 'spam') {
      if (!deps.config.dryRun) {
        await deps.mail.moveToTrash(account, message.uid, {
          sourceMailbox: account.inbox,
          messageId: message.messageId,
        });
      }
      await deps.store.markProcessed(
        account.slug,
        message.uid,
        deps.config.dryRun ? 'would_trash' : 'trashed',
        message.messageId,
      );
      return 'trashed';
    }
    await deps.store.markProcessed(account.slug, message.uid, 'kept', message.messageId);
    return 'kept';
  }

  const hasAllowRule = await deps.store.hasAllowRule(redacted.fromHash, redacted.domainHash);
  const modelConfig = {
    baseUrl: deps.config.openAiBaseUrl,
    apiKey: deps.config.openAiApiKey,
    model: deps.config.model,
    timeoutMs: deps.config.modelTimeoutMs,
  };
  const briefRow = await deps.store.getLatestBrief();
  const classifyInput = {
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
    ...(briefRow ? { feedbackSummary: briefRow.brief } : {}),
  };

  let classifyFailed = false;
  let classification: MailAssessment | null = null;
  let verification: MailAssessment | null = null;

  try {
    classification = await classifyEmail(modelConfig, classifyInput);
  } catch (err) {
    classifyFailed = true;
    process.stderr.write(
      `${JSON.stringify({
        event: 'mail_guardian_classify_failed',
        level: 'warn',
        stage: 'classify',
        account: account.slug,
        uid: message.uid,
        error: err instanceof Error ? err.message : String(err),
      })}\n`,
    );
  }

  if (classification) {
    try {
      verification = await adjudicateEmail(modelConfig, classifyInput, classification);
    } catch (err) {
      classifyFailed = true;
      process.stderr.write(
        `${JSON.stringify({
          event: 'mail_guardian_classify_failed',
          level: 'warn',
          stage: 'verify',
          account: account.slug,
          uid: message.uid,
          error: err instanceof Error ? err.message : String(err),
        })}\n`,
      );
    }
  }

  if (classification && verification && shouldKeepInInbox(classification, verification)) {
    await deps.store.recordDecision({
      accountSlug: account.slug,
      messageUid: message.uid,
      fromHash: redacted.fromHash,
      domainHash: redacted.domainHash,
      summary: redacted.summary,
      model: deps.config.model,
      verdict: classification.verdict,
      confidence: classification.confidence,
      spamScore: classification.spamScore,
      category: classification.category,
      senderLegitimacy: classification.senderLegitimacy,
      reasons: classification.reasons,
      riskSignals: classification.riskSignals,
      verifyModel: deps.config.model,
      verifyVerdict: verification.verdict,
      verifyConfidence: verification.confidence,
      verifySpamScore: verification.spamScore,
      verifyCategory: verification.category,
      verifySenderLegitimacy: verification.senderLegitimacy,
      outcome: 'kept',
    });
    await deps.store.markProcessed(account.slug, message.uid, 'kept', message.messageId);
    return 'kept';
  }

  if (
    classification &&
    verification &&
    shouldAutoQuarantine({ classification, verification, hasAllowRule })
  ) {
    if (!deps.config.dryRun) {
      await deps.mail.moveToTrash(account, message.uid, {
        sourceMailbox: account.inbox,
        messageId: message.messageId,
      });
    }
    const autoReviewId = await deps.store.createPendingReview({
      accountSlug: account.slug,
      messageUid: message.uid,
      messageId: message.messageId,
      ...redacted,
      subject: message.subject,
      bodyHtml: message.bodyHtml,
      body: message.bodyText ?? message.text,
      modelVerdict: classification.verdict,
      modelConfidence: classification.confidence,
      spamScore: classification.spamScore,
      category: classification.category,
      senderLegitimacy: classification.senderLegitimacy,
      sourceMailbox: 'inbox',
    });
    await deps.store.recordDecision({
      accountSlug: account.slug,
      messageUid: message.uid,
      fromHash: redacted.fromHash,
      domainHash: redacted.domainHash,
      summary: redacted.summary,
      model: deps.config.model,
      verdict: classification.verdict,
      confidence: classification.confidence,
      spamScore: classification.spamScore,
      category: classification.category,
      senderLegitimacy: classification.senderLegitimacy,
      reasons: classification.reasons,
      riskSignals: classification.riskSignals,
      verifyModel: deps.config.model,
      verifyVerdict: verification.verdict,
      verifyConfidence: verification.confidence,
      verifySpamScore: verification.spamScore,
      verifyCategory: verification.category,
      verifySenderLegitimacy: verification.senderLegitimacy,
      outcome: 'auto_trashed',
    });
    await deps.store.resolveReview(autoReviewId, 'spam', 'auto');
    await deps.store.markProcessed(
      account.slug,
      message.uid,
      deps.config.dryRun ? 'would_trash' : 'trashed',
      message.messageId,
    );
    if (telegramEnabled(deps.config) && deps.config.telegramOwnerChatId) {
      await deps.telegram.sendMessage(
        deps.config.telegramOwnerChatId,
        `Auto-trashed: ${redacted.subjectHash}`,
      );
    }
    return 'trashed';
  }

  const reviewVerdict = classification?.verdict ?? 'uncertain';
  const reviewConfidence = classification?.confidence ?? 0;
  const reviewId = await deps.store.createPendingReview({
    accountSlug: account.slug,
    messageUid: message.uid,
    messageId: message.messageId,
    ...redacted,
    subject: message.subject,
    bodyHtml: message.bodyHtml,
    body: message.bodyText ?? message.text,
    modelVerdict: reviewVerdict,
    modelConfidence: reviewConfidence,
    spamScore: classification?.spamScore ?? 0,
    category: classification?.category ?? 'suspicious',
    senderLegitimacy: classification?.senderLegitimacy ?? 'unknown',
    sourceMailbox: 'inbox',
  });
  await deps.store.recordDecision({
    accountSlug: account.slug,
    messageUid: message.uid,
    fromHash: redacted.fromHash,
    domainHash: redacted.domainHash,
    summary: redacted.summary,
    model: classification ? deps.config.model : null,
    verdict: classification?.verdict ?? null,
    confidence: classification?.confidence ?? null,
    spamScore: classification?.spamScore ?? null,
    category: classification?.category ?? null,
    senderLegitimacy: classification?.senderLegitimacy ?? null,
    reasons: classification?.reasons ?? [],
    riskSignals: classification?.riskSignals ?? [],
    verifyModel: verification ? deps.config.model : null,
    verifyVerdict: verification?.verdict ?? null,
    verifyConfidence: verification?.confidence ?? null,
    verifySpamScore: verification?.spamScore ?? null,
    verifyCategory: verification?.category ?? null,
    verifySenderLegitimacy: verification?.senderLegitimacy ?? null,
    outcome: 'pending',
  });
  if (telegramEnabled(deps.config) && deps.config.telegramOwnerChatId) {
    await deps.telegram.sendMessage(
      deps.config.telegramOwnerChatId,
      buildReviewMessage({
        accountAddress: account.address,
        from: message.from,
        subject: message.subject,
        verdict: reviewVerdict,
        confidence: reviewConfidence,
        reviewId,
      }),
      {
        inline_keyboard: [
          [
            { text: '🗑️ Spam -> Trash', callback_data: `mg:${reviewId}:spam` },
            { text: '✅ Keep in Inbox', callback_data: `mg:${reviewId}:keep` },
          ],
          [
            { text: '🚫 Block sender', callback_data: `mg:${reviewId}:block_sender` },
            { text: '🛡️ Allow sender', callback_data: `mg:${reviewId}:allow_sender` },
          ],
        ],
      },
    );
  }
  await deps.store.markProcessed(
    account.slug,
    message.uid,
    classifyFailed ? 'classify_failed' : 'pending_review',
    message.messageId,
  );
  return 'review';
}

export async function applyReviewDecision(
  deps: ProcessDeps,
  reviewId: number,
  decision: string,
  approver: string,
): Promise<void> {
  const review = await deps.store.getReview(reviewId);
  if (!review) throw new Error(`review ${reviewId} is already resolved or missing`);
  const account = deps.config.accounts.find((item) => item.slug === review.account_slug);
  if (!account) throw new Error(`account missing for review ${reviewId}`);
  const sourceMailbox = review.source_mailbox === 'inbox' ? account.inbox : account.reviewMailbox;
  if (decision === 'spam' || decision === 'block_sender') {
    if (!deps.config.dryRun) {
      await deps.mail.moveToTrash(account, review.message_uid, {
        sourceMailbox,
        messageId: review.message_id ?? undefined,
      });
    }
    await deps.store.markProcessed(
      account.slug,
      review.message_uid,
      deps.config.dryRun ? 'would_trash' : 'trashed',
    );
    if (decision === 'block_sender') {
      await deps.store.addRule('block', 'sender', review.from_hash);
    }
  } else if (decision === 'keep' || decision === 'allow_sender') {
    if (!deps.config.dryRun && sourceMailbox !== account.inbox) {
      await deps.mail.moveToInbox(account, review.message_uid, {
        sourceMailbox,
        messageId: review.message_id ?? undefined,
      });
    }
    await deps.store.markProcessed(account.slug, review.message_uid, 'kept');
    if (decision === 'allow_sender') await deps.store.addRule('allow', 'sender', review.from_hash);
  } else {
    throw new Error(`unknown decision: ${decision}`);
  }
  const outcomeMap: Record<string, string> = {
    spam: 'owner_spam',
    keep: 'owner_keep',
    block_sender: 'owner_block',
    allow_sender: 'owner_allow',
  };
  await deps.store.updateDecisionOutcome(
    review.account_slug,
    review.message_uid,
    outcomeMap[decision],
    { fromHash: review.from_hash, domainHash: review.domain_hash },
  );
  await deps.store.resolveReview(reviewId, decision, approver);
  if (
    (decision === 'spam' || decision === 'block_sender') &&
    telegramEnabled(deps.config) &&
    deps.config.telegramOwnerChatId
  ) {
    const { spam, allow } = await deps.store.countDomainOutcomes(review.domain_hash);
    if (
      spam >= DOMAIN_BLOCK_THRESHOLD &&
      allow === 0 &&
      !(await deps.store.hasRule('block', 'domain', review.domain_hash)) &&
      !(await deps.store.hasRule('allow', 'domain', review.domain_hash)) &&
      !skippedDomains.has(review.domain_hash)
    ) {
      await deps.telegram.sendMessage(
        deps.config.telegramOwnerChatId,
        `Domain flagged: ${spam} owner-confirmed spams, no keeps. Block all mail from this domain?`,
        {
          inline_keyboard: [
            [
              { text: '🚫 Block domain', callback_data: `mgdom:${reviewId}:block` },
              { text: '⏭️ Skip', callback_data: `mgdom:${reviewId}:skip` },
            ],
          ],
        },
      );
    }
  }
}

export async function sweep(deps: ProcessDeps): Promise<{
  processed: number;
  trashed: number;
  review: number;
  kept: number;
  skipped: number;
  failed: number;
  actions: number;
  openReviews: number;
}> {
  let processed = 0;
  let trashed = 0;
  let review = 0;
  let kept = 0;
  let skipped = 0;
  let failed = 0;
  let actions = 0;
  await runSequentially(await deps.store.claimPendingActions(), async (action) => {
    try {
      await applyReviewDecision(deps, action.review_id, action.decision, action.approver);
      await deps.store.completeAction(action.id);
      actions += 1;
    } catch (error) {
      failed += 1;
      await deps.store.failAction(
        action.id,
        error instanceof Error ? error.message : String(error),
      );
    }
  });
  await runSequentially(deps.config.accounts, async (account) => {
    let accountProcessed = 0;
    let messages: MailMessage[] = [];
    try {
      messages = await deps.mail.listInbox(account);
    } catch (error) {
      failed += 1;
      process.stderr.write(
        `[mail-guardian] ${account.slug} list failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    await runSequentially(messages, async (message) => {
      if (accountProcessed >= deps.config.maxMessagesPerSweep) return STOP;
      let action: 'review' | 'kept' | 'skipped' | 'trashed' | undefined;
      try {
        action = await processMessage(deps, account, message);
      } catch (error) {
        failed += 1;
        process.stderr.write(
          `[mail-guardian] ${account.slug}:${message.uid} failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
      if (action) {
        processed += 1;
        if (action === 'skipped') {
          skipped += 1;
        } else {
          accountProcessed += 1;
          if (action === 'review') review += 1;
          else if (action === 'kept') kept += 1;
          else if (action === 'trashed') trashed += 1;
        }
      }
      return undefined;
    });
  });
  const openReviews = await deps.store.countOpenReviews();
  if (openReviews > OPEN_REVIEW_BACKLOG_THRESHOLD) {
    process.stderr.write(
      `${JSON.stringify({
        event: 'mail_guardian_backlog_warning',
        level: 'warn',
        openReviews,
        threshold: OPEN_REVIEW_BACKLOG_THRESHOLD,
      })}\n`,
    );
    await deps.store.raiseBacklogAlert(openReviews, OPEN_REVIEW_BACKLOG_THRESHOLD);
  }
  return { processed, trashed, review, kept, skipped, failed, actions, openReviews };
}

export async function handleTelegramUpdates(
  deps: ProcessDeps,
  updates: TelegramUpdate[],
): Promise<number> {
  let handled = 0;
  const relevantUpdates = updates.filter((update) => {
    const callback = update.callback_query;
    const data = callback?.data;
    return callback && (data?.startsWith('mg:') || data?.startsWith('mgdom:'));
  });
  await runSequentially(relevantUpdates, async (update) => {
    const callback = update.callback_query!;
    const data = callback.data!;
    const parts = data.split(':');
    const prefix = parts[0];

    if (prefix === 'mgdom') {
      const reviewId = Number(parts[1]);
      const action = parts[2];
      if (!Number.isInteger(reviewId)) return;
      const domainHash = await deps.store.getReviewDomainHash(reviewId);
      if (!domainHash) {
        await deps.telegram.answerCallbackQuery(callback.id, 'Proposal expired.');
        return;
      }
      if (action === 'block') {
        await deps.store.addRule('block', 'domain', domainHash);
        await deps.telegram.answerCallbackQuery(callback.id, 'Domain blocked.');
        handled += 1;
      } else if (action === 'skip') {
        skippedDomains.add(domainHash);
        await deps.telegram.answerCallbackQuery(callback.id, 'Domain proposal dismissed.');
        handled += 1;
      }
      return;
    }

    const [, reviewIdRaw, decision] = parts;
    const reviewId = Number(reviewIdRaw);
    if (Number.isInteger(reviewId)) {
      const reviewRecord = await deps.store.getReview(reviewId);
      if (reviewRecord) {
        const account = deps.config.accounts.find(
          (item) => item.slug === reviewRecord.account_slug,
        );
        if (account) {
          if (
            decision === 'spam' ||
            decision === 'keep' ||
            decision === 'block_sender' ||
            decision === 'allow_sender'
          ) {
            await applyReviewDecision(
              deps,
              reviewId,
              decision,
              String(callback.message?.chat?.id ?? 'telegram'),
            );
            await deps.telegram.answerCallbackQuery(callback.id, 'Recorded.');
            handled += 1;
          } else {
            await deps.telegram.answerCallbackQuery(callback.id, 'Unknown decision.');
          }
        } else {
          await deps.telegram.answerCallbackQuery(callback.id, 'Account missing.');
        }
      } else {
        await deps.telegram.answerCallbackQuery(callback.id, 'Review already resolved or missing.');
      }
    }
  });
  return handled;
}
