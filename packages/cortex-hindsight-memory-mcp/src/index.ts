#!/usr/bin/env node
import process from 'node:process';
import pc from 'picocolors';
import { runStdioServer } from './server.js';

function getEnv(): { cwd: string; baseUrl: string; apiKey?: string } {
  const cwd = process.env.CORTEX_HINDSIGHT_CWD ?? process.cwd();
  const baseUrl = process.env.HINDSIGHT_API_URL ?? 'http://127.0.0.1:8888';
  const apiKey = process.env.HINDSIGHT_API_KEY;

  if (!baseUrl) {
    console.error(pc.red('[cortex-hindsight-memory] HINDSIGHT_API_URL is not set'));
    process.exit(1);
  }

  return { cwd, baseUrl, apiKey };
}

async function main(): Promise<void> {
  const env = getEnv();
  await runStdioServer(env);
}

main().catch((err: unknown) => {
  console.error(pc.red('[cortex-hindsight-memory] fatal error'), err);
  process.exit(1);
});
