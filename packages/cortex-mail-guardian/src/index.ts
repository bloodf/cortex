import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { listenerStep } from './backoff.js';
import { accountFromRow, loadConfig, mergeAccounts, telegramEnabled } from './config.js';
import { getMailGuardianEnvPath } from './env.js';
import { ImapConnectionClosedError, TlsImapMailClient } from './imap.js';
import { GuardianStore } from './store.js';
import { assertTelegramReady, BotApiTelegramClient, discoverOwnerChatId } from './telegram.js';
import { applyReviewDecision, handleTelegramUpdates, sweep } from './processor.js';
import { distillBrief } from './distill.js';
import { adjudicateEmail, classifyEmail, shouldAutoQuarantine } from './model.js';
import { parseReconcileArgs, reconcileReviews, type ReconcileReview } from './reconcile.js';

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export function makeListenerOnError(accountSlug: string): (err: unknown) => void {
  return (err: unknown) => {
    if (err instanceof ImapConnectionClosedError) {
      process.stdout.write(
        `[mail-guardian] ${accountSlug} reconnecting after server-side IMAP disconnect\n`,
      );
    } else {
      process.stderr.write(`[mail-guardian] ${accountSlug} listener error: ${String(err)}\n`);
    }
  };
}

function disabledTelegramClient() {
  return {
    getMe: async () => {
      throw new Error('TELEGRAM_BOT_TOKEN is not configured');
    },
    getChat: async () => {
      throw new Error('TELEGRAM_BOT_TOKEN is not configured');
    },
    sendMessage: async () => undefined,
    getUpdates: async () => [],
    answerCallbackQuery: async () => undefined,
  };
}

async function buildDeps() {
  const config = loadConfig();
  const mail = new TlsImapMailClient();
  const store = new GuardianStore(config);
  await store.ensureSchema();
  // DB-backed accounts take precedence by slug; env accounts remain for
  // backward compatibility. The merged set replaces config.accounts.
  const dbRows = await store.listAccounts();
  const dbAccounts = dbRows.map(accountFromRow);
  config.accounts = mergeAccounts(config.accounts, dbAccounts);
  if (config.accounts.length < 1) {
    throw new Error(
      'no mail accounts configured (set MAIL_GUARDIAN_ACCOUNT_* env vars or add a row to mail_guardian_accounts)',
    );
  }
  const telegram = config.telegramBotToken
    ? new BotApiTelegramClient(config.telegramBotToken)
    : disabledTelegramClient();
  return { config, mail, store, telegram };
}

async function smoke(): Promise<void> {
  const { config, telegram, store } = await buildDeps();
  try {
    if (!config.telegramOwnerChatId) {
      throw new Error('MAIL_GUARDIAN_TELEGRAM_OWNER_CHAT_ID is required for smoke');
    }
    if (!config.telegramBotToken) {
      throw new Error('TELEGRAM_BOT_TOKEN is required for smoke');
    }
    await assertTelegramReady(telegram, config.telegramOwnerChatId);
    const modelsRes = await fetch(`${config.openAiBaseUrl.replace(/\/+$/, '')}/models`, {
      headers: { authorization: `Bearer ${config.openAiApiKey}` },
    });
    if (!modelsRes.ok) throw new Error(`LLM models check failed: ${modelsRes.status}`);
    const models = (await modelsRes.json()) as { data?: { id?: string }[] };
    if (!models.data?.some((model) => model.id === config.model)) {
      throw new Error(`LLM model unavailable: ${config.model}`);
    }
    process.stdout.write('cortex-mail-guardian smoke ok\n');
  } finally {
    await store.close();
  }
}

// Runs a single sweep against ALREADY-BUILT deps. The caller owns the deps
// lifecycle (build/close); this function never tears them down. The long-lived
// `listen` loop reuses one set of deps across every idle cycle so it does not
// rebuild the IMAP client / DB pool or re-run ensureSchema on each wake.
export async function runSweepWithDeps(
  deps: Awaited<ReturnType<typeof buildDeps>>,
  sweepFn: typeof sweep = sweep,
): Promise<void> {
  if (!telegramEnabled(deps.config) || !deps.config.telegramOwnerChatId) {
    process.stderr.write(
      '[mail-guardian] Telegram not fully configured (needs both TELEGRAM_BOT_TOKEN and MAIL_GUARDIAN_TELEGRAM_OWNER_CHAT_ID); review notifications disabled.\n',
    );
  } else {
    await assertTelegramReady(deps.telegram, deps.config.telegramOwnerChatId);
  }
  const result = await sweepFn(deps);
  process.stdout.write(`${JSON.stringify({ event: 'mail_guardian_sweep', ...result })}\n`);
}

// One-shot `sweep` command path: legitimately builds deps once, runs, and exits.
async function runSweep(): Promise<void> {
  const deps = await buildDeps();
  try {
    await runSweepWithDeps(deps);
  } finally {
    await deps.mail.close();
    await deps.store.close();
  }
}

async function pollTelegramReviews(deps: Awaited<ReturnType<typeof buildDeps>>): Promise<void> {
  if (!telegramEnabled(deps.config)) return undefined;
  let offset: number | undefined;
  const loop = async (): Promise<void> => {
    try {
      const updates = await deps.telegram.getUpdates(offset);
      if (updates.length > 0) {
        offset = Math.max(...updates.map((update) => update.update_id)) + 1;
        const handled = await handleTelegramUpdates(deps, updates);
        if (handled > 0) {
          process.stdout.write(
            `${JSON.stringify({ event: 'mail_guardian_telegram_decisions', handled })}\n`,
          );
        }
      }
    } catch (error) {
      process.stderr.write(
        `[mail-guardian] telegram polling error: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      await sleep(30_000);
    }
    return loop();
  };
  return loop();
}

async function listen(): Promise<void> {
  const deps = await buildDeps();
  if (!telegramEnabled(deps.config) || !deps.config.telegramOwnerChatId) {
    process.stderr.write(
      '[mail-guardian] Telegram not fully configured (needs both TELEGRAM_BOT_TOKEN and MAIL_GUARDIAN_TELEGRAM_OWNER_CHAT_ID); Telegram polling disabled.\n',
    );
  } else {
    await assertTelegramReady(deps.telegram, deps.config.telegramOwnerChatId);
  }
  // Initial sweep + every idle-wake sweep reuse the deps built once above.
  // The IMAP client self-heals via session.ensureConnected() on each
  // waitForNewMail, so a dropped connection reconnects without rebuilding deps
  // or re-running ensureSchema; only an error path triggers backoff.
  await runSweepWithDeps(deps);
  const listeners = deps.config.accounts.map((account) => {
    const loop = async (attempt = 0): Promise<void> => {
      const next = await listenerStep(attempt, {
        waitForNewMail: () => deps.mail.waitForNewMail(account),
        sweep: () => runSweepWithDeps(deps),
        sleep,
        onError: makeListenerOnError(account.slug),
      });
      return loop(next);
    };
    return loop();
  });
  await Promise.all([pollTelegramReviews(deps), ...listeners]);
}

function upsertEnvLine(path: string, key: string, value: string): void {
  const raw = readFileSync(path, 'utf8');
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^#?\\s*${key}=.*$`, 'm');
  const next = pattern.test(raw)
    ? raw.replace(pattern, line)
    : `${raw.replace(/\n?$/, '\n')}${line}\n`;
  writeFileSync(path, next, { mode: 0o600 });
}

async function telegramDiscoverOwner(): Promise<void> {
  const { telegram, store } = await buildDeps();
  try {
    const chatId = await discoverOwnerChatId(telegram);
    if (process.argv.includes('--write-env')) {
      upsertEnvLine(getMailGuardianEnvPath(), 'MAIL_GUARDIAN_TELEGRAM_OWNER_CHAT_ID', chatId);
    }
    process.stdout.write(`${chatId}\n`);
  } finally {
    await store.close();
  }
}

async function decide(): Promise<void> {
  const reviewId = Number(process.argv[3]);
  const decision = process.argv[4];
  if (!Number.isInteger(reviewId) || !decision) {
    throw new Error(
      'usage: cortex-mail-guardian decide <review-id> <spam|keep|block_sender|allow_sender>',
    );
  }
  const deps = await buildDeps();
  try {
    await applyReviewDecision(deps, reviewId, decision, 'cortex-telegram');
    process.stdout.write(`${JSON.stringify({ ok: true, reviewId, decision })}\n`);
  } finally {
    await deps.mail.close();
    await deps.store.close();
  }
}

export async function distillWithDeps(
  deps: Awaited<ReturnType<typeof buildDeps>>,
  distillFn: typeof distillBrief = distillBrief,
): Promise<void> {
  const result = await distillFn(deps);
  process.stdout.write(`${JSON.stringify({ event: 'mail_guardian_distill', ...result })}\n`);
}

async function runDistill(): Promise<void> {
  const deps = await buildDeps();
  try {
    await distillWithDeps(deps);
  } finally {
    await deps.store.close();
  }
}

async function runReconcile(): Promise<void> {
  const options = parseReconcileArgs(process.argv.slice(3));
  const deps = await buildDeps();
  try {
    const rows = options.ids
      ? await deps.store.listOpenReviewsByIds(options.ids)
      : await deps.store.listOpenReviews(options.limit, options.offset);
    const modelConfig = {
      baseUrl: deps.config.openAiBaseUrl,
      apiKey: deps.config.openAiApiKey,
      model: deps.config.model,
      timeoutMs: deps.config.modelTimeoutMs,
    };
    const result = await reconcileReviews(
      {
        accounts: new Map(deps.config.accounts.map((account) => [account.slug, account])),
        mail: deps.mail,
        hasAllowRule: (fromHash, domainHash) => deps.store.hasAllowRule(fromHash, domainHash),
        classify: (input) => classifyEmail(modelConfig, input),
        adjudicate: (input, first) => adjudicateEmail(modelConfig, input, first),
        shouldTrash: shouldAutoQuarantine,
      },
      rows.map(
        (row): ReconcileReview => ({
          id: row.id,
          accountSlug: row.account_slug,
          messageUid: row.message_uid,
          messageId: row.message_id,
          fromHash: row.from_hash,
          domainHash: row.domain_hash,
          sourceMailbox: row.source_mailbox,
        }),
      ),
      options,
    );
    process.stdout.write(
      `${JSON.stringify({ event: 'mail_guardian_reconcile_dry_run', ...result })}\n`,
    );
  } finally {
    await deps.mail.close();
    await deps.store.close();
  }
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'sweep';
  if (command === 'smoke') await smoke();
  else if (command === 'sweep') await runSweep();
  else if (command === 'listen') await listen();
  else if (command === 'telegram-discover-owner') await telegramDiscoverOwner();
  else if (command === 'decide') await decide();
  else if (command === 'distill') await runDistill();
  else if (command === 'reconcile') await runReconcile();
  else throw new Error(`unknown command: ${command}`);
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(
      `cortex-mail-guardian: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
