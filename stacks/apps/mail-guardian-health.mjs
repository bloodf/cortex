import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import tls from 'node:tls';
import net from 'node:net';

// Read-only dependency proof: no sweeps, messages, mailbox changes or schema writes.
const root = process.env.CORTEX_ROOT;
if (!root) throw new Error('CORTEX_ROOT is required');
const dist = resolve(root, 'packages/cortex-mail-guardian/dist');
const { loadConfig, accountFromRow, mergeAccounts } = await import(pathToFileURL(resolve(dist, 'config.js')));
const { GuardianStore } = await import(pathToFileURL(resolve(dist, 'store.js')));
const quote = (value) => {
  if (/[\r\n\0]/.test(value)) throw new Error('Invalid IMAP credential encoding');
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
};
async function authenticate(account) {
  const login = `cortexhealth LOGIN ${quote(account.username)} ${quote(account.password)}\r\n`;
  await new Promise((resolvePromise, reject) => {
    const socket = account.secure
      ? tls.connect({ host: account.host, port: account.port, servername: account.host, rejectUnauthorized: true })
      : net.connect({ host: account.host, port: account.port });
    let pending = '';
    let sent = false;
    let finished = false;
    const finish = (ok) => {
      if (finished) return;
      finished = true;
      socket.destroy();
      if (ok) resolvePromise();
      else reject(new Error('IMAP authentication unavailable'));
    };
    socket.setTimeout(15000, () => finish(false));
    socket.on('error', () => finish(false));
    socket.on('end', () => finish(false));
    socket.on('data', (data) => {
      pending += data.toString('utf8');
      if (pending.length > 65536) return finish(false);
      let end;
      while ((end = pending.indexOf('\r\n')) >= 0) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 2);
        if (!sent && /^\* PREAUTH\b/i.test(line)) return finish(true);
        if (!sent && /^\* OK\b/i.test(line)) {
          sent = true;
          socket.write(login);
        } else if (/^cortexhealth OK\b/i.test(line)) return finish(true);
        else if (/^(cortexhealth (NO|BAD)|\* BYE)\b/i.test(line)) return finish(false);
      }
    });
  });
}
let store;
try {
  const config = loadConfig();
  store = new GuardianStore(config);
  const accounts = mergeAccounts(config.accounts, (await store.listAccounts()).map(accountFromRow));
  if (!accounts.length) throw new Error('Configure at least one mail account');
  const response = await fetch(config.openAiBaseUrl.replace(/\/+$/, '') + '/models', {
    headers: { authorization: `Bearer ${config.openAiApiKey}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error('Model endpoint unavailable');
  const payload = await response.json();
  for (const model of new Set([config.model, config.fallbackModel])) {
    if (!payload.data?.some((item) => item.id === model)) throw new Error('Configured model unavailable');
  }
  for (const account of accounts) await authenticate(account);
  console.log('Mail Guardian database, configured models and IMAP authentication ready');
} catch {
  // Never disclose account names, addresses, tokens, database URLs or remote errors.
  console.error('Mail Guardian verification failed; inspect configuration locally');
  process.exitCode = 1;
} finally {
  if (store) await store.close();
}
