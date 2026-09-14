import { describe, expect, it } from 'vitest';
import { assertTelegramReady, discoverOwnerChatId, type TelegramClient } from '../src/telegram.js';

describe('telegram owner discovery', () => {
  it('finds a private /start chat', async () => {
    const client: TelegramClient = {
      getMe: async () => ({ id: 1 }),
      getChat: async () => ({ id: 1, type: 'private' }),
      sendMessage: async () => undefined,
      answerCallbackQuery: async () => undefined,
      getUpdates: async () => [
        {
          update_id: 1,
          message: { text: '/start', chat: { id: 42, type: 'private' } },
        },
      ],
    };
    await expect(discoverOwnerChatId(client)).resolves.toBe('42');
  });
});

describe('telegram readiness', () => {
  it('checks the bot and owner chat without sending a Telegram message', async () => {
    let sent = false;
    const client: TelegramClient = {
      getMe: async () => ({ id: 1 }),
      getChat: async () => ({ id: 42, type: 'private' }),
      sendMessage: async () => {
        sent = true;
      },
      answerCallbackQuery: async () => undefined,
      getUpdates: async () => [],
    };

    await assertTelegramReady(client, '42');

    expect(sent).toBe(false);
  });
});
