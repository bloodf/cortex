import { getProcessEnv } from './env.js';

export interface MailAccountConfig {
  slug: string;
  address: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  inbox: string;
  reviewMailbox: string;
  trashMailbox?: string;
}

export interface GuardianConfig {
  accounts: MailAccountConfig[];
  model: string;
  fallbackModel: string;
  confidenceThreshold: number;
  action: 'trash';
  telegramBotToken?: string;
  telegramOwnerChatId?: string;
  openAiBaseUrl: string;
  openAiApiKey: string;
  databaseUrl?: string;
  maxMessagesPerSweep: number;
  modelTimeoutMs: number;
  db: {
    host: string;
    port: number;
    database: string;
    user: string;
    password?: string;
  };
  dryRun: boolean;
}

function env(name: string, source: NodeJS.ProcessEnv): string | undefined {
  const value = source[name];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function requireEnv(name: string, source: NodeJS.ProcessEnv): string {
  const value = env(name, source);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseIntEnv(name: string, source: NodeJS.ProcessEnv, fallback?: number): number {
  const raw = env(name, source);
  if (!raw) {
    if (fallback !== undefined) return fallback;
    throw new Error(`${name} is required`);
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (!raw) return fallback;
  if (/^(1|true|yes)$/i.test(raw)) return true;
  if (/^(0|false|no)$/i.test(raw)) return false;
  throw new Error(`invalid boolean value: ${raw}`);
}

function normalizeOpenAiBaseUrl(value: string): string {
  const trimmed = value.replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

export function decodeBase64Secret(name: string, value: string): string {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error(`${name} must be valid padded base64`);
  }
  const decoded = Buffer.from(value, 'base64').toString('utf8');
  if (!decoded) throw new Error(`${name} decoded to an empty value`);
  const normalized = Buffer.from(decoded, 'utf8').toString('base64');
  if (normalized !== value) throw new Error(`${name} must be canonical base64`);
  return decoded;
}

function loadAccount(index: number, source: NodeJS.ProcessEnv): MailAccountConfig {
  const prefix = `MAIL_GUARDIAN_ACCOUNT_${index}_`;
  return {
    slug: requireEnv(`${prefix}SLUG`, source),
    address: requireEnv(`${prefix}ADDRESS`, source),
    host: requireEnv(`${prefix}HOST`, source),
    port: parseIntEnv(`${prefix}PORT`, source, 993),
    secure: parseBool(env(`${prefix}SECURE`, source), true),
    username: requireEnv(`${prefix}USERNAME`, source),
    password: decodeBase64Secret(
      `${prefix}PASSWORD_B64`,
      requireEnv(`${prefix}PASSWORD_B64`, source),
    ),
    inbox: env(`${prefix}INBOX`, source) ?? 'INBOX',
    reviewMailbox: env(`${prefix}REVIEW_MAILBOX`, source) ?? 'INBOX.Cortex Mail Guardian Review',
    trashMailbox: env(`${prefix}TRASH_MAILBOX`, source),
  };
}

export function loadConfig(source: NodeJS.ProcessEnv = getProcessEnv()): GuardianConfig {
  // Accounts can come from env (MAIL_GUARDIAN_ACCOUNT_N_*) and/or the
  // mail_guardian_accounts DB table (merged later in buildDeps). When the
  // count is absent or 0 we treat env accounts as empty and rely on the DB.
  const rawCount = env('MAIL_GUARDIAN_ACCOUNT_COUNT', source);
  const accountCount = rawCount ? parseIntEnv('MAIL_GUARDIAN_ACCOUNT_COUNT', source) : 0;
  const accounts = Array.from({ length: accountCount }, (_, idx) => loadAccount(idx + 1, source));
  const slugs = new Set(accounts.map((account) => account.slug));
  if (slugs.size !== accounts.length) throw new Error('mail account slugs must be unique');
  const confidenceThreshold = Number(env('MAIL_GUARDIAN_CONFIDENCE_THRESHOLD', source) ?? '0.98');
  if (!Number.isFinite(confidenceThreshold) || confidenceThreshold < 0 || confidenceThreshold > 1) {
    throw new Error('MAIL_GUARDIAN_CONFIDENCE_THRESHOLD must be between 0 and 1');
  }
  const action = env('MAIL_GUARDIAN_ACTION', source) ?? 'trash';
  if (action !== 'trash') throw new Error('MAIL_GUARDIAN_ACTION must be trash');

  return {
    accounts,
    model: env('MAIL_GUARDIAN_MODEL', source) ?? 'minimax/MiniMax-M3',
    fallbackModel: env('MAIL_GUARDIAN_FALLBACK_MODEL', source) ?? 'minimax/MiniMax-M3',
    confidenceThreshold,
    action,
    telegramBotToken: env('TELEGRAM_BOT_TOKEN', source),
    // Read the chat id directly. It must not be gated on the bot token: the two
    // are independent secrets, and gating the id on the token was a copy-paste
    // bug that hid a configured chat id whenever the token was absent. The
    // actual SEND path is gated on telegramBotToken in index.ts (the disabled
    // client is installed when no token is present), so a chat id without a
    // token simply means "no doomed send is attempted" — not a crash.
    telegramOwnerChatId: env('MAIL_GUARDIAN_TELEGRAM_OWNER_CHAT_ID', source),
    openAiBaseUrl: normalizeOpenAiBaseUrl(
      env('OPENAI_BASE_URL', source) ?? 'https://api.openai.com/v1',
    ),
    openAiApiKey: requireEnv('OPENAI_API_KEY', source),
    databaseUrl: env('DATABASE_URL', source) ?? env('PG_DSN', source),
    maxMessagesPerSweep: parseIntEnv('MAIL_GUARDIAN_MAX_MESSAGES_PER_SWEEP', source, 20),
    modelTimeoutMs: parseIntEnv('MAIL_GUARDIAN_MODEL_TIMEOUT_MS', source, 120_000),
    db: {
      host: env('DB_HOST', source) ?? 'localhost',
      port: parseIntEnv('DB_PORT', source, 5432),
      database: env('DB_NAME', source) ?? 'cortex_dashboard',
      user: env('DB_USER', source) ?? 'dashboard',
      password: env('DB_PASSWORD', source),
    },
    dryRun: parseBool(env('MAIL_GUARDIAN_DRY_RUN', source), false),
  };
}

/**
 * Telegram is "live" only when BOTH the bot token (authorises the API call)
 * and the owner chat id (the recipient) are configured. Sending needs the
 * token; with only a chat id the disabled client is installed and any send is
 * a no-op, so callers must gate readiness checks / sends on this — otherwise a
 * chat-id-without-token config would try (and fail) to reach the Telegram API.
 */
export function telegramEnabled(config: {
  telegramBotToken?: string;
  telegramOwnerChatId?: string;
}): boolean {
  return Boolean(config.telegramBotToken && config.telegramOwnerChatId);
}

/** Shape of a DB-backed account row (subset used to build MailAccountConfig). */
export interface AccountRowInput {
  slug: string;
  address: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password_b64: string;
  inbox: string;
  trash_mailbox: string | null;
  review_mailbox: string;
}

/** Map a DB account row to the runtime MailAccountConfig, decoding the password. */
export function accountFromRow(row: AccountRowInput): MailAccountConfig {
  return {
    slug: row.slug,
    address: row.address,
    host: row.host,
    port: row.port,
    secure: row.secure,
    username: row.username,
    password: decodeBase64Secret(`account ${row.slug} password_b64`, row.password_b64),
    inbox: row.inbox || 'INBOX',
    reviewMailbox: row.review_mailbox || 'INBOX.Cortex Mail Guardian Review',
    trashMailbox: row.trash_mailbox ?? undefined,
  };
}

/**
 * Merge DB-backed accounts with env-configured accounts. DB rows take
 * precedence by slug; env accounts not present in the DB are preserved
 * (backward compatibility with MAIL_GUARDIAN_ACCOUNT_N_* config).
 */
export function mergeAccounts(
  envAccounts: MailAccountConfig[],
  dbAccounts: MailAccountConfig[],
): MailAccountConfig[] {
  // env first, then db — db values override env by slug while preserving the
  // original (env-first) iteration order of each slug's first appearance.
  const bySlug = new Map<string, MailAccountConfig>(
    [...envAccounts, ...dbAccounts].map((account) => [account.slug, account]),
  );
  return [...bySlug.values()];
}
