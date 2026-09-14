import { HindsightClient } from './hindsight.js';
import deriveBankId from './bank.js';
import { getHindsightApiUrl, getHindsightApiKey, getHindsightCwd } from './env.js';

/**
 * OpenCode event-hook plugin for Hindsight memory.
 *
 * OpenCode plugin/hooks API is unverified against installed versions; this
 * module exports a factory and named event handlers that the OpenCode plugin
 * loader wires up. The fallback (if `experimental.session.compacting` is
 * unavailable) is retain-only; recall then happens via the MCP server tools.
 *
 * Reference: https://opencode.ai/docs/plugins
 */

export interface PluginEnv {
  baseUrl: string;
  apiKey?: string;
  cwd: string;
}

export interface OpenCodeMessage {
  role?: string;
  content?: string;
  parts?: { type?: string; text?: string }[];
}

export interface OpenCodeEvent {
  event: string;
  payload: unknown;
}

type EventHandler = (event: OpenCodeEvent) => void | Promise<void>;

export interface PluginApi {
  on?: (event: string, handler: EventHandler) => void;
  tool?: (name: string, handler: (args: unknown) => Promise<unknown>) => void;
}

export interface PluginDefinition {
  name: string;
  setup?: (api: PluginApi) => void;
  handlers?: Record<string, EventHandler>;
}

function envFromProcess(): PluginEnv {
  return {
    baseUrl: getHindsightApiUrl(),
    apiKey: getHindsightApiKey(),
    cwd: getHindsightCwd(),
  };
}

/**
 * Build the Hindsight plugin. Pure factory — side effects only when handlers fire.
 */
export function createHindsightPlugin(env: PluginEnv = envFromProcess()): PluginDefinition {
  const client = new HindsightClient(env);

  const onMessageUpdated: EventHandler = (event) => {
    const msg = event.payload as OpenCodeMessage | undefined;
    const role = msg?.role;
    const text = msg?.content
      ?? msg?.parts?.map((p) => p?.text ?? '').filter(Boolean).join('\n')
      ?? '';
    if (!text || !role) return undefined;
    return client.retain(text, `opencode:${role}`).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[opencode-hindsight] retain failed: ${message}`);
    });
  };

  const onSessionCompacting: EventHandler = async (event) => {
    const messages = (event.payload as { messages?: OpenCodeMessage[] } | undefined)?.messages ?? [];
    const query = messages
      .map((m) => m?.content
        ?? m?.parts?.map((p) => p?.text ?? '').filter(Boolean).join(' ')
        ?? '')
      .filter(Boolean)
      .join(' ');
    if (!query) return;
    const results = await client.recall(query).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[opencode-hindsight] recall failed: ${message}`);
      return [];
    });
    if (results.length > 0) {
      const summary = results.map((r, i) => `[${i + 1}] ${r.content ?? ''}`).join('\n');
      console.error(`[opencode-hindsight] recalled ${results.length} memories from bank ${client.bankId}:\n${summary}`);
    }
  };

  const handlers: Record<string, EventHandler> = {
    'message.updated': onMessageUpdated,
    'experimental.session.compacting': onSessionCompacting,
  };

  return {
    name: 'hindsight',
    setup(api) {
      if (typeof api?.on === 'function') {
        for (const [event, handler] of Object.entries(handlers)) {
          api.on(event, handler);
        }
      }
    },
    handlers,
  };
}

export { deriveBankId };
export default createHindsightPlugin;
