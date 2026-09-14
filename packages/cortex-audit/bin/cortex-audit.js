#!/usr/bin/env node
/**
 * cortex-audit CLI.
 *
 * Subcommands:
 *   verify  [--from ISO] [--to ISO]
 *           Verify the hash chain across the window. Exit 0 = intact, 1 = broken.
 *   anchor  [--since ISO]
 *           Verify-since-last-anchor and, if intact, anchor the latest tip to Rekor.
 *           Exit 0 = anchored or nothing to anchor, 2 = chain broken, 3 = anchor error.
 *
 * Intended to be invoked from scripts/audit-anchor-cron.sh and from
 * operator-driven verification runs. Never blocks production: failures are
 * surfaced via non-zero exit status only.
 */
import { verifyChain, anchorToRekor } from '../src/index.js';

function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--from') out.from = argv[(i += 1)];
    else if (a === '--to') out.to = argv[(i += 1)];
    else if (a === '--since') out.since = argv[(i += 1)];
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function usage() {
  process.stdout.write(
    `Usage: cortex-audit <verify|anchor> [options]

  verify  [--from ISO] [--to ISO]
  anchor  [--since ISO]
`,
  );
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const flags = parseFlags(rest);

  if (!cmd || flags.help) {
    usage();
    process.exitCode = cmd ? 0 : 64;
    return;
  }

  if (cmd === 'verify') {
    const result = await verifyChain(
      flags.from ? new Date(flags.from) : undefined,
      flags.to ? new Date(flags.to) : undefined,
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.valid ? 0 : 1;
    return;
  }

  if (cmd === 'anchor') {
    const since = flags.since ? new Date(flags.since) : undefined;
    const v = await verifyChain(since);
    if (!v.valid) {
      process.stderr.write(`audit chain broken: ${JSON.stringify(v)}\n`);
      process.exitCode = 2;
      return;
    }
    try {
      const result = await anchorToRekor(since);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      process.exitCode = 0;
      return;
    } catch (e) {
      process.stderr.write(`anchor failed: ${e.message}\n`);
      process.exitCode = 3;
      return;
    }
  }

  usage();
  process.exitCode = 64;
}

main().catch((e) => {
  process.stderr.write(`cortex-audit: ${e.stack || e.message}\n`);
  process.exitCode = 1;
});
