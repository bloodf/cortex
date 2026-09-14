import https from 'node:https';
import lookupWithFallback from './dns.js';

export interface TelegramClient {
  getMe(): Promise<{ id: number; username?: string; first_name?: string }>;
  getChat(chatId: string): Promise<{ id: number; type: string; username?: string; title?: string }>;
  sendMessage(chatId: string, text: string, replyMarkup?: unknown): Promise<void>;
  getUpdates(offset?: number): Promise<TelegramUpdate[]>;
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
}

export interface TelegramUpdate {
  update_id: number;
  message?: {
    text?: string;
    chat?: { id: number; type: string; username?: string; first_name?: string };
  };
  callback_query?: {
    id: string;
    data?: string;
    message?: { chat?: { id: number } };
  };
}

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

function telegramRequest<T>(
  token: string,
  method: string,
  body?: Record<string, unknown>,
): Promise<TelegramResponse<T>> {
  const encoded = body ? JSON.stringify(body) : undefined;
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.telegram.org',
        path: `/bot${token}/${method}`,
        method: body ? 'POST' : 'GET',
        lookup: lookupWithFallback,
        headers: encoded
          ? {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(encoded),
            }
          : undefined,
        timeout: 20_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as TelegramResponse<T>);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error(`Telegram ${method} timed out`));
    });
    if (encoded) req.write(encoded);
    req.end();
  });
}

export class BotApiTelegramClient implements TelegramClient {
  constructor(private readonly token: string) {}

  private async call<T>(method: string, body?: Record<string, unknown>): Promise<T> {
    const payload = await telegramRequest<T>(this.token, method, body);
    if (!payload.ok || payload.result === undefined) {
      throw new Error(
        `Telegram ${method} failed: ${payload.description ?? payload.error_code ?? 'unknown error'}`,
      );
    }
    return payload.result;
  }

  getMe(): Promise<{ id: number; username?: string; first_name?: string }> {
    return this.call('getMe');
  }

  getChat(
    chatId: string,
  ): Promise<{ id: number; type: string; username?: string; title?: string }> {
    return this.call('getChat', { chat_id: chatId });
  }

  async sendMessage(chatId: string, text: string, replyMarkup?: unknown): Promise<void> {
    await this.call('sendMessage', {
      chat_id: chatId,
      text,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }

  getUpdates(offset?: number): Promise<TelegramUpdate[]> {
    return this.call('getUpdates', {
      timeout: 20,
      allowed_updates: ['message', 'callback_query'],
      ...(offset ? { offset } : {}),
    });
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    await this.call('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
    });
  }
}

export async function discoverOwnerChatId(client: TelegramClient): Promise<string> {
  const updates = await client.getUpdates();
  const started = updates
    .map((update) => update.message)
    .find((message) => message?.text?.trim() === '/start' && message.chat?.type === 'private');
  if (!started?.chat?.id) {
    throw new Error('no private /start message found for Cortex bot');
  }
  return String(started.chat.id);
}

export async function assertTelegramReady(
  client: TelegramClient,
  ownerChatId: string,
): Promise<void> {
  await client.getMe();
  await client.getChat(ownerChatId);
}
