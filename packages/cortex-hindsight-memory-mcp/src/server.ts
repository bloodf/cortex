import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import pc from 'picocolors';
import { HindsightMemoryStore } from './hindsight.js';
import { deriveBankId } from './workspace.js';

export interface ServerEnv {
  cwd: string;
  baseUrl: string;
  apiKey?: string;
}

export function createMcpServer(env: ServerEnv): McpServer {
  const store = new HindsightMemoryStore({
    cwd: env.cwd,
    baseUrl: env.baseUrl,
    apiKey: env.apiKey,
  });

  const server = new McpServer({
    name: 'cortex-hindsight-memory',
    version: '0.1.0',
  });

  server.tool(
    'hindsight_store_memory',
    'Persist a fact, preference, or observation about the current directory/project. Scoped to the working directory, not global.',
    {
      content: z.string().min(1).max(4000).describe('The memory text to store.'),
      context: z
        .string()
        .max(1000)
        .optional()
        .describe('Optional short context label, e.g. "tech-stack" or "user-preference".'),
    },
    async ({ content, context }) => {
      const result = await store.store(content, context);
      const count = typeof result.items_count === 'number' ? result.items_count : 1;
      const ok = result.success !== false;
      return {
        content: [
          {
            type: 'text',
            text: `${ok ? 'Memory stored' : 'Store call completed'} in bank ${store.bankId}\nItems: ${count}`,
          },
        ],
      };
    },
  );

  server.tool(
    'hindsight_recall_memory',
    'Semantic recall of directory-scoped memories for the current project.',
    {
      query: z.string().min(1).max(1000).describe('The query or topic to recall.'),
      top_k: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe('Maximum number of memories to return (advisory; Hindsight uses budget tiers).'),
    },
    async ({ query, top_k }) => {
      const response = await store.recall(query, top_k);
      const results = response.results ?? [];
      if (results.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: 'No relevant memories found for this directory.',
            },
          ],
        };
      }
      const text = results
        .map((r, idx) => `[${idx + 1}] ${r.content ?? JSON.stringify(r)}`)
        .join('\n\n');
      return {
        content: [
          {
            type: 'text',
            text: `Recalled ${results.length} memory(s) from bank ${store.bankId}:\n\n${text}`,
          },
        ],
      };
    },
  );

  server.tool(
    'hindsight_reflect_memory',
    'LLM-synthesized answer from this directory\'s stored memories.',
    {
      query: z.string().min(1).max(1000).describe('The question to synthesize an answer for.'),
    },
    async ({ query }) => {
      const response = await store.reflect(query);
      const answer = response.answer ?? response.results?.[0]?.content ?? JSON.stringify(response);
      return {
        content: [
          {
            type: 'text',
            text: `Reflection from bank ${store.bankId}:\n\n${answer}`,
          },
        ],
      };
    },
  );

  server.tool(
    'hindsight_list_memories',
    'List stored memories for the current directory/project.',
    {
      limit: z.number().int().min(1).max(100).optional().describe('Items to return (default 50).'),
      offset: z.number().int().min(0).optional().describe('Pagination offset (default 0).'),
    },
    async ({ limit, offset }) => {
      const response = await store.list(limit ?? 50, offset ?? 0);
      const items = response.items ?? [];
      if (items.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: 'No memories stored for this directory yet.',
            },
          ],
        };
      }
      const text = items
        .map((it, idx) => `[${idx + 1}] ${it.content ?? ''}\nID: ${it.id ?? '?'} | Created: ${it.created_at ?? '?'}${it.state ? ` | State: ${it.state}` : ''}`)
        .join('\n\n');
      return {
        content: [
          {
            type: 'text',
            text: `Found ${items.length} memory(s) in bank ${store.bankId}:\n\n${text}`,
          },
        ],
      };
    },
  );

  server.tool(
    'hindsight_forget_memory',
    'Soft-delete a memory by ID (invalidated, excluded from recall, reversible). Not a hard delete.',
    {
      id: z.string().min(1).describe('The memory ID returned when the memory was stored.'),
    },
    async ({ id }) => {
      await store.forget(id);
      return {
        content: [
          {
            type: 'text',
            text: `Memory ${id} invalidated in bank ${store.bankId}.`,
          },
        ],
      };
    },
  );

  server.tool(
    'hindsight_current_bank',
    'Show the Hindsight bank id derived from the current working directory.',
    {},
    async () => {
      const bankId = deriveBankId(env.cwd);
      return {
        content: [
          {
            type: 'text',
            text: `Current directory: ${env.cwd}\nHindsight bank: ${bankId}`,
          },
        ],
      };
    },
  );

  return server;
}

export async function runStdioServer(env: ServerEnv): Promise<void> {
  const server = createMcpServer(env);
  const transport = new StdioServerTransport();
  console.error(
    pc.gray(
      `[cortex-hindsight-memory] bank=${deriveBankId(env.cwd)} baseUrl=${env.baseUrl}`,
    ),
  );
  await server.connect(transport);
}
