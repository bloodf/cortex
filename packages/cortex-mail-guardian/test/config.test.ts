import { describe, expect, it } from 'vitest';
import {
  accountFromRow,
  decodeBase64Secret,
  loadConfig,
  mergeAccounts,
  telegramEnabled,
} from '../src/config.js';

function baseEnv(): NodeJS.ProcessEnv {
  const password = Buffer.from('dummy#password;with.symbols', 'utf8').toString('base64');
  return {
    MAIL_GUARDIAN_ACCOUNT_COUNT: '3',
    MAIL_GUARDIAN_ACCOUNT_1_SLUG: 'example-owner',
    MAIL_GUARDIAN_ACCOUNT_1_ADDRESS: 'owner@example.test',
    MAIL_GUARDIAN_ACCOUNT_1_HOST: 'mail.example.test',
    MAIL_GUARDIAN_ACCOUNT_1_PORT: '993',
    MAIL_GUARDIAN_ACCOUNT_1_USERNAME: 'owner@example.test',
    MAIL_GUARDIAN_ACCOUNT_1_PASSWORD_B64: password,
    MAIL_GUARDIAN_ACCOUNT_2_SLUG: 'example-contact',
    MAIL_GUARDIAN_ACCOUNT_2_ADDRESS: 'contact@example.test',
    MAIL_GUARDIAN_ACCOUNT_2_HOST: 'mail.example.test',
    MAIL_GUARDIAN_ACCOUNT_2_PORT: '993',
    MAIL_GUARDIAN_ACCOUNT_2_USERNAME: 'contact@example.test',
    MAIL_GUARDIAN_ACCOUNT_2_PASSWORD_B64: password,
    MAIL_GUARDIAN_ACCOUNT_3_SLUG: 'example-personal',
    MAIL_GUARDIAN_ACCOUNT_3_ADDRESS: 'me@example.test',
    MAIL_GUARDIAN_ACCOUNT_3_HOST: 'mail.example.test',
    MAIL_GUARDIAN_ACCOUNT_3_PORT: '993',
    MAIL_GUARDIAN_ACCOUNT_3_USERNAME: 'me@example.test',
    MAIL_GUARDIAN_ACCOUNT_3_PASSWORD_B64: password,
    TELEGRAM_BOT_TOKEN: 'token',
    OPENAI_API_KEY: 'key',
  };
}

describe('config', () => {
  it('loads configured base64 password accounts', () => {
    const config = loadConfig(baseEnv());
    expect(config.accounts).toHaveLength(3);
    expect(config.accounts[0].password).toBe('dummy#password;with.symbols');
    expect(config.accounts[2].host).toBe('mail.example.test');
    expect(config.accounts[2].reviewMailbox).toBe('INBOX.Cortex Mail Guardian Review');
    expect(config.model).toBe('minimax/MiniMax-M3');
    expect(config.confidenceThreshold).toBe(0.98);
    expect(config.modelTimeoutMs).toBe(120_000);
  });

  it('rejects invalid base64', () => {
    expect(() => decodeBase64Secret('SECRET', 'not-base64')).toThrow(/base64/);
  });

  it('rejects a zero account count', () => {
    const input = baseEnv();
    input.MAIL_GUARDIAN_ACCOUNT_COUNT = '0';
    expect(() => loadConfig(input)).toThrow(/positive integer/);
  });

  it('loads with no env accounts when the count is absent (DB-only mode)', () => {
    const config = loadConfig({ OPENAI_API_KEY: 'key' });
    expect(config.accounts).toHaveLength(0);
  });
});

describe('telegram configuration gate', () => {
  it('reads the owner chat id directly, independent of the bot token', () => {
    // Regression: the chat id used to be gated on TELEGRAM_BOT_TOKEN (a
    // copy-paste bug), so a configured chat id vanished whenever the token was
    // absent. With only the chat id set, telegramOwnerChatId must be defined.
    const config = loadConfig({
      OPENAI_API_KEY: 'key',
      MAIL_GUARDIAN_TELEGRAM_OWNER_CHAT_ID: '123456789',
    });
    expect(config.telegramOwnerChatId).toBe('123456789');
    expect(config.telegramBotToken).toBeUndefined();
  });

  it('treats Telegram as disabled (send path skipped) when the token is absent', () => {
    const config = loadConfig({
      OPENAI_API_KEY: 'key',
      MAIL_GUARDIAN_TELEGRAM_OWNER_CHAT_ID: '123456789',
    });
    // chat id present, token absent → not live → no doomed send attempted.
    expect(telegramEnabled(config)).toBe(false);
  });

  it('treats Telegram as live only when both token and chat id are present', () => {
    const config = loadConfig({
      OPENAI_API_KEY: 'key',
      TELEGRAM_BOT_TOKEN: 'bot-token',
      MAIL_GUARDIAN_TELEGRAM_OWNER_CHAT_ID: '123456789',
    });
    expect(config.telegramBotToken).toBe('bot-token');
    expect(config.telegramOwnerChatId).toBe('123456789');
    expect(telegramEnabled(config)).toBe(true);
  });

  it('is not live when the chat id is absent even if the token is present', () => {
    const config = loadConfig({ OPENAI_API_KEY: 'key', TELEGRAM_BOT_TOKEN: 'bot-token' });
    expect(telegramEnabled(config)).toBe(false);
  });
});

describe('model and fallback configuration', () => {
  it('defaults both scoring passes to MiniMax M3 without an OpenAI fallback', () => {
    const config = loadConfig({ OPENAI_API_KEY: 'key' });
    expect(config.model).toBe('minimax/MiniMax-M3');
    expect(config.fallbackModel).toBe('minimax/MiniMax-M3');
    expect(config.fallbackModel).not.toMatch(/^gpt-/);
  });

  it('respects env overrides for model and fallbackModel', () => {
    const config = loadConfig({
      OPENAI_API_KEY: 'key',
      MAIL_GUARDIAN_MODEL: 'custom/primary',
      MAIL_GUARDIAN_FALLBACK_MODEL: 'custom/fallback',
    });
    expect(config.model).toBe('custom/primary');
    expect(config.fallbackModel).toBe('custom/fallback');
  });
});

describe('DB-backed accounts', () => {
  const row = {
    slug: 'db-inbox',
    address: 'db@example.com',
    host: 'mail.example.com',
    port: 993,
    secure: true,
    username: 'db@example.com',
    password_b64: Buffer.from('db-secret', 'utf8').toString('base64'),
    inbox: 'INBOX',
    trash_mailbox: null,
    review_mailbox: 'INBOX.Cortex Mail Guardian Review',
  };

  it('maps a DB row to a runtime account and decodes the password', () => {
    const account = accountFromRow(row);
    expect(account.slug).toBe('db-inbox');
    expect(account.password).toBe('db-secret');
    expect(account.trashMailbox).toBeUndefined();
  });

  it('lets DB accounts override env accounts by slug', () => {
    const envAccount = accountFromRow({ ...row, slug: 'shared', host: 'env-host' });
    const dbAccount = accountFromRow({ ...row, slug: 'shared', host: 'db-host' });
    const merged = mergeAccounts([envAccount], [dbAccount]);
    expect(merged).toHaveLength(1);
    expect(merged[0].host).toBe('db-host');
  });

  it('keeps env accounts not present in the DB', () => {
    const envOnly = accountFromRow({ ...row, slug: 'env-only' });
    const dbOnly = accountFromRow({ ...row, slug: 'db-only' });
    const merged = mergeAccounts([envOnly], [dbOnly]);
    expect(merged.map((a) => a.slug).sort()).toEqual(['db-only', 'env-only']);
  });
});
