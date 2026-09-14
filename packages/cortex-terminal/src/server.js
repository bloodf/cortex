// @ts-check
/**
 * CortexOS Terminal PTY Sidecar (WP-19)
 * ------------------------------------------------------------------------
 * A standalone Node WebSocket server that hosts an interactive admin shell
 * (node-pty) for the dashboard's xterm UI. It is a SEPARATE process from the
 * live dashboard (`cortex-dashboard.service` on :3080); it can be restarted
 * independently and cannot crash the dashboard.
 *
 * Transport: `ws` WebSocketServer bound to loopback (default 127.0.0.1:3081).
 * Caddy reverse-proxies `wss://<host>/terminal/ws` → 127.0.0.1:3081 with the
 * standard WebSocket upgrade headers.
 *
 * SECURITY MODEL (admin-only host shell):
 *   1. Cookie auth   — the `cortexos_session` HttpOnly cookie from the upgrade
 *                      request is validated against Postgres `admin_sessions`
 *                      (token + expiry). No row → close 4401.
 *   2. RBAC          — admin is RE-DERIVED LIVE from OS group membership of
 *                      `cortexos-admin` (`id -Gn`), NOT from the denormalized
 *                      `admin_sessions.is_admin` column, AND the account must
 *                      still be active on the host (`id -u`), AND the dashboard
 *                      must have re-confirmed the role within ROLE_CHECK_MAX_AGE
 *                      (`last_role_check_at`). This mirrors the dashboard so a
 *                      revoked admin / disabled account loses the shell instead
 *                      of riding a stale session row. Not currently admin → 4403.
 *   3. CSRF / origin — the WS `Origin` header MUST equal ALLOWED_ORIGIN to stop
 *                      cross-site WebSocket hijacking (the cookie alone is not
 *                      enough; browsers send cookies on cross-site WS too).
 *   4. PTY           — a real shell (default /bin/bash). Admins already have host
 *                      access (same model as the legacy /api/terminal), so this
 *                      is an unrestricted server shell, gated only by the auth
 *                      checks above.
 *
 * Re-validation gates NEW grants only. Live PTYs already open when an admin is
 * revoked are not force-closed mid-session (they end on idle timeout / exit /
 * disconnect). Periodic re-validation + teardown of live sessions is a tracked
 * follow-up (see REMEDIATION notes), not implemented here.
 *
 * Privacy: we log connection lifecycle (user, ip, close codes) but NEVER pty
 * content (no keystrokes, no output).
 *
 * Wire protocol (client → server, JSON text frames):
 *   { type: 'input',  data: string }
 *   { type: 'resize', cols: number, rows: number }
 * Server → client: raw pty bytes are sent as text frames (xterm writes them
 * directly). A control frame `{ type: 'exit', code }` is sent on pty exit.
 */

import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

import { WebSocketServer } from 'ws';
import pkg from 'pg';
import * as pty from 'node-pty';

const { Client } = pkg;

// ---------------------------------------------------------------------------
// Config (all overridable via env / EnvironmentFile)
// ---------------------------------------------------------------------------

const HOST = process.env.TERMINAL_HOST || '127.0.0.1';
const PORT = parseInt(process.env.TERMINAL_PORT || '3081', 10);
const SHELL = process.env.TERMINAL_SHELL || '/bin/bash';
const CWD = process.env.TERMINAL_CWD || process.env.HOME || '/root';
const IDLE_SEC = parseInt(process.env.TERMINAL_IDLE_SEC || '900', 10);
// ALLOWED_ORIGIN is the public dashboard origin, e.g. https://cortex.example.ts.net
// If unset, origin enforcement is skipped with a loud warning (dev only).
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '';

const SESSION_COOKIE = 'cortexos_session';

// The dashboard re-validates a session's admin role against live OS group
// membership whenever `admin_sessions.last_role_check_at` is older than its
// ROLE_CHECK_TTL_MS (60s; see dashboard-next src/server/context.ts). The
// terminal re-derives admin live on every upgrade, but it ALSO honors this
// freshness bound as defence-in-depth: if the dashboard has not confirmed the
// role within this window the grant is refused, so a stale row can never be
// the sole basis for a root shell. Slightly larger than the dashboard's 60s to
// tolerate clock skew between the two services.
const ROLE_CHECK_MAX_AGE_MS = parseInt(process.env.TERMINAL_ROLE_CHECK_MAX_AGE_MS || '120000', 10);

// The only OS group that confers admin (root shell). Mirrors the dashboard's
// single admin-bearing group (dashboard-next src/server/auth/pam.ts).
const ADMIN_GROUP = 'cortexos-admin';

// ---------------------------------------------------------------------------
// Structured logging (NEVER logs pty content)
// ---------------------------------------------------------------------------

/** @param {string} msg @param {Record<string, unknown>} [fields] */
function log(msg, fields) {
  const ts = new Date().toISOString();
  const extra = fields
    ? ` ${Object.entries(fields)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(' ')}`
    : '';
  process.stdout.write(`[${ts}] cortex-terminal: ${msg}${extra}\n`);
}

// ---------------------------------------------------------------------------
// Postgres session validation
// ---------------------------------------------------------------------------

/**
 * Build a pg connection config from the same DB_* env the dashboard uses
 * (supplied via EnvironmentFile=/etc/cortex/secrets/dashboard.env).
 * @returns {import('pg').ClientConfig}
 */
export function dbConfig() {
  if (!process.env.DB_PASSWORD && !process.env.DATABASE_URL) {
    throw new Error('DB_PASSWORD (or DATABASE_URL) is required');
  }
  if (process.env.DATABASE_URL) {
    return { connectionString: process.env.DATABASE_URL };
  }
  return {
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'cortex_dashboard',
    user: process.env.DB_USER || 'dashboard',
    password: process.env.DB_PASSWORD,
  };
}

/**
 * Parse a Cookie header into a flat map. Defensive: never throws.
 * @param {string | undefined} header
 * @returns {Record<string, string>}
 */
export function parseCookies(header) {
  /** @type {Record<string, string>} */
  const out = {};
  if (!header) return out;
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (!k) return;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      // Malformed %-escape (e.g. a lone "%"): keep the raw value rather than
      // throw, so a crafted Cookie header can't break the upgrade handler.
      out[k] = v;
    }
  });
  return out;
}

/**
 * Live OS account-active probe. An account that has been deleted or otherwise
 * removed from the system has no uid, so `id -u <user>` exits non-zero. Mirrors
 * the dashboard's `safeUserExists` (dashboard-next src/server/auth/pam.ts): a
 * disabled/removed account must not keep a privileged shell. Returns false on
 * any failure (fail-closed). Never throws.
 * @param {string} username
 * @returns {boolean}
 */
export function osUserActive(username) {
  if (!username) return false;
  try {
    const out = execFileSync('id', ['-u', username], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return /^\d+$/.test(out.trim());
  } catch {
    // `id` exits non-zero when the user doesn't exist. Treat as inactive.
    return false;
  }
}

/**
 * Live re-derivation of admin from OS group membership. Calls `id -Gn <user>`
 * and checks for `cortexos-admin`, EXACTLY as the dashboard does
 * (LinuxPamAuthenticator.isAdmin in dashboard-next src/server/auth/pam.ts).
 * This is the source of truth for admin — never the denormalized
 * `admin_sessions.is_admin` column. Returns false on any failure (fail-closed).
 * Never throws.
 * @param {string} username
 * @returns {boolean}
 */
export function osUserIsAdmin(username) {
  if (!username) return false;
  try {
    const out = execFileSync('id', ['-Gn', username], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .includes(ADMIN_GROUP);
  } catch {
    return false;
  }
}

/**
 * Pure decision core for whether a session row earns a root PTY. Extracted so
 * it can be unit-tested with real-shaped rows and injected OS probes, WITHOUT
 * opening a database or a PTY. Do NOT weaken any check here to ease testing.
 *
 * Security requirements (all must hold to grant):
 *   1. The row exists and is unexpired (enforced by the SQL `expires_at > now()`
 *      filter; a null/absent row here means "no valid session" → deny).
 *   2. The account is ACTIVE on the host right now (`osUserActive`). A deleted
 *      or disabled account is denied even if a session row survives.
 *   3. Admin is RE-DERIVED LIVE from OS group membership (`osUserIsAdmin`); the
 *      stored `is_admin` column is NOT trusted. Only a live admin gets a shell.
 *   4. Freshness bound: the dashboard's `last_role_check_at` must be within
 *      ROLE_CHECK_MAX_AGE_MS, so the dashboard has recently re-confirmed the
 *      role (defence-in-depth against an OS probe that is fooled or skipped).
 *
 * @param {{ username: string, lastRoleCheckAt: number } | null} row
 * @param {{
 *   userActive: (u: string) => boolean,
 *   isAdmin: (u: string) => boolean,
 *   now?: () => number,
 *   maxRoleAgeMs?: number,
 * }} deps
 * @returns {{ isAdmin: boolean, username: string } | null}
 */
export function deriveSessionGrant(row, deps) {
  if (!row) return null;
  const username = String(row.username || '');
  if (!username) return null;

  // 2. Account must be active on the host right now.
  if (!deps.userActive(username)) {
    log('rejected: account inactive', { user: username });
    return null;
  }

  // 4. Freshness bound — the dashboard must have re-confirmed the role recently.
  const now = (deps.now ?? Date.now)();
  const maxAge = deps.maxRoleAgeMs ?? ROLE_CHECK_MAX_AGE_MS;
  const lastRoleCheckAt = Number(row.lastRoleCheckAt) || 0;
  if (now - lastRoleCheckAt > maxAge) {
    log('rejected: stale role check', { user: username, lastRoleCheckAt });
    return null;
  }

  // 3. Re-derive admin LIVE from OS group membership; ignore the stored column.
  const isAdmin = deps.isAdmin(username) === true;
  return { isAdmin, username };
}

/**
 * Validate the session token against `admin_sessions`. A fresh short-lived
 * pg Client is used per upgrade (low volume, avoids a stale pool on a server
 * that mostly idles). Returns null on any failure.
 *
 * The grant is NOT based on the denormalized `admin_sessions.is_admin` column:
 * that value is never re-validated by the terminal and would let a user whose
 * admin was revoked (removed from `cortexos-admin`, or whose account was
 * disabled) keep a root shell. Instead we re-derive admin + account-active
 * LIVE from the OS via `deriveSessionGrant`, mirroring the dashboard.
 * @param {string} token
 * @returns {Promise<{ isAdmin: boolean, username: string } | null>}
 */
async function validateSession(token) {
  const client = new Client(dbConfig());
  try {
    await client.connect();
    const res = await client.query(
      'select u.username, s.last_role_check_at from admin_sessions s ' +
        'join pam_users u on u.id = s.user_id ' +
        'where s.token = $1 and s.expires_at > now()',
      [token],
    );
    if (res.rowCount === 0) return null;
    const row = res.rows[0];
    return deriveSessionGrant(
      { username: String(row.username), lastRoleCheckAt: Number(row.last_role_check_at) },
      { userActive: osUserActive, isAdmin: osUserIsAdmin },
    );
  } catch (err) {
    log('session validation error', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Best-effort client IP from the upgrade request (X-Forwarded-For aware, since
 * Caddy proxies). Never used as an auth signal — forensic only.
 * @param {import('node:http').IncomingMessage} req
 */
export function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    return xff.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

/**
 * Decide whether a WS upgrade's Origin is allowed. This is the CSRF defense:
 * browsers send cookies on cross-site WS too, so the cookie alone is not enough.
 *   - allowedOrigin a concrete origin → require an exact Origin match.
 *   - allowedOrigin unset or "same-origin" → require the Origin's host to equal
 *     the Host being connected to (correct behind Caddy/Tailscale where there is
 *     no single fixed public origin). A missing / unparseable Origin is rejected.
 * @param {string | undefined} origin the request `Origin` header
 * @param {string | undefined} host the request `Host` header
 * @param {string} allowedOrigin the ALLOWED_ORIGIN config value
 * @returns {boolean}
 */
export function checkOrigin(origin, host, allowedOrigin) {
  const sameOriginMode = !allowedOrigin || allowedOrigin === 'same-origin';
  if (!sameOriginMode) {
    return origin === allowedOrigin;
  }
  let originHost = null;
  try {
    originHost = origin ? new URL(origin).host : null;
  } catch {
    originHost = null;
  }
  return Boolean(originHost) && originHost === host;
}

// ---------------------------------------------------------------------------
// HTTP + WebSocket server
// ---------------------------------------------------------------------------

const httpServer = createServer((req, res) => {
  // Tiny health endpoint so the orchestrator can probe liveness without a WS.
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok\n');
    return;
  }
  res.writeHead(426, { 'content-type': 'text/plain' });
  res.end('upgrade required\n');
});

// noServer: we own the upgrade so we can authenticate BEFORE accepting the WS.
const wss = new WebSocketServer({ noServer: true });

// Active PTY session cleanup functions (for global fatal teardown).
/** @type {Set<() => void>} */
const sessions = new Set();

let fatalTeardownDone = false;
let shutdownTimer = null;

/**
 * Single fatal teardown path. Sets exitCode and closes every handle so the
 * event loop can drain and the process exits naturally. Idempotent.
 * @param {string} reason
 * @param {number} [exitCode]
 */
function fatal(reason, exitCode = 1) {
  if (fatalTeardownDone) return;
  fatalTeardownDone = true;
  log(reason ? `fatal: ${reason}` : 'fatal', { exitCode });

  if (shutdownTimer) {
    clearTimeout(shutdownTimer);
    shutdownTimer = null;
  }

  Array.from(sessions).forEach((cleanupFn) => {
    try {
      cleanupFn();
    } catch {
      /* ignore */
    }
  });

  wss.clients.forEach((client) => {
    try {
      client.terminate();
    } catch {
      /* ignore */
    }
  });

  try {
    wss.close();
  } catch {
    /* ignore */
  }

  if (httpServer.listening) {
    try {
      httpServer.close();
    } catch {
      /* ignore */
    }
  }

  process.exitCode = exitCode;
}

/**
 * Reject a raw upgrade socket with an HTTP status before the WS is established.
 * @param {import('node:stream').Duplex} socket
 * @param {number} status
 */
function abortHandshake(socket, status) {
  const text =
    { 401: 'Unauthorized', 403: 'Forbidden', 500: 'Internal Server Error' }[status] || 'Error';
  try {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
  } catch {
    /* socket already gone */
  }
  socket.destroy();
}

/**
 * Accept the WS handshake then immediately close with an app-level code so
 * the browser's xterm UI can distinguish 4401/4403 and show the right state.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:stream').Duplex} socket
 * @param {Buffer} head
 * @param {number} code
 * @param {string} reason
 * @param {string} ip
 */
function acceptThenClose(req, socket, head, code, reason, ip) {
  wss.handleUpgrade(req, socket, head, (ws) => {
    log('rejected after upgrade', { ip, code, reason });
    try {
      ws.close(code, reason);
    } catch {
      ws.terminate();
    }
  });
}

// ---------------------------------------------------------------------------
// Per-connection PTY session
// ---------------------------------------------------------------------------

/**
 * @param {import('ws').WebSocket} ws
 * @param {string} user
 * @param {string} ip
 */
function handleSession(ws, user, ip) {
  /** @type {import('node-pty').IPty | null} */
  let term = null;
  /** @type {NodeJS.Timeout | null} */
  let idleTimer = null;

  const cleanup = () => {
    sessions.delete(cleanup);
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (term) {
      const t = term;
      term = null;
      try {
        t.kill();
      } catch {
        /* already dead */
      }
    }
  };
  sessions.add(cleanup);

  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (IDLE_SEC > 0) {
      idleTimer = setTimeout(() => {
        log('idle timeout — killing pty', { user, ip, idleSec: IDLE_SEC });
        cleanup();
        try {
          ws.close(4408, 'idle timeout');
        } catch {
          ws.terminate();
        }
      }, IDLE_SEC * 1000);
    }
  };

  try {
    term = pty.spawn(SHELL, [], {
      name: 'xterm-color',
      cols: 80,
      rows: 24,
      cwd: CWD,
      env: { ...process.env, TERM: 'xterm-color' },
    });
  } catch (err) {
    log('pty spawn failed', {
      user,
      ip,
      error: err instanceof Error ? err.message : String(err),
    });
    try {
      ws.close(4500, 'pty spawn failed');
    } catch {
      ws.terminate();
    }
    cleanup();
    return;
  }

  log('session opened', { user, ip, pid: term.pid });
  resetIdle();

  // PTY → WS. Raw bytes are forwarded as text frames; xterm writes them as-is.
  term.onData((data) => {
    if (ws.readyState === ws.OPEN) {
      try {
        ws.send(data);
      } catch {
        /* peer gone; close handler will clean up */
      }
    }
  });

  term.onExit(({ exitCode }) => {
    log('pty exited', { user, ip, exitCode });
    if (ws.readyState === ws.OPEN) {
      try {
        ws.send(JSON.stringify({ type: 'exit', code: exitCode }));
      } catch {
        /* ignore */
      }
      try {
        ws.close(4000, 'pty exited');
      } catch {
        ws.terminate();
      }
    }
    cleanup();
  });

  // WS → PTY. Never crash on a malformed message.
  ws.on('message', (raw) => {
    resetIdle();
    if (!term) return;
    let msg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
    } catch {
      return; // ignore non-JSON frames
    }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'input' && typeof msg.data === 'string') {
      try {
        term.write(msg.data);
      } catch {
        /* pty gone */
      }
    } else if (msg.type === 'resize') {
      const cols = Number(msg.cols);
      const rows = Number(msg.rows);
      if (
        Number.isInteger(cols) &&
        Number.isInteger(rows) &&
        cols > 0 &&
        rows > 0 &&
        cols <= 1000 &&
        rows <= 1000
      ) {
        try {
          term.resize(cols, rows);
        } catch {
          /* pty gone */
        }
      }
    }
  });

  ws.on('close', (code) => {
    log('session closed', { user, ip, code });
    cleanup();
  });

  ws.on('error', (err) => {
    log('ws error', {
      user,
      ip,
      error: err instanceof Error ? err.message : String(err),
    });
    cleanup();
  });
}

httpServer.on('upgrade', (req, socket, head) => {
  // Wrap everything so a malformed upgrade can never crash the process.
  (async () => {
    const ip = clientIp(req);

    // 1. Origin / CSRF check — reject cross-site WS hijacking. Browsers send
    // cookies on cross-site WS too, so the cookie alone is not enough.
    //   - ALLOWED_ORIGIN set to a concrete origin → require exact match.
    //   - ALLOWED_ORIGIN unset or "same-origin" → require the Origin's host to
    //     equal the Host being connected to (correct behind Caddy :80/Tailscale
    //     where there is no single fixed public origin). No Origin → reject.
    const { origin } = req.headers;
    if (!checkOrigin(origin, req.headers.host, ALLOWED_ORIGIN)) {
      const sameOriginMode = !ALLOWED_ORIGIN || ALLOWED_ORIGIN === 'same-origin';
      log(
        sameOriginMode
          ? 'rejected: cross-origin WS (same-origin enforced)'
          : 'rejected: origin mismatch',
        { ip, origin: origin || null, host: req.headers.host || null },
      );
      abortHandshake(socket, 403);
      return;
    }

    // 2. Cookie → session token.
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[SESSION_COOKIE];
    if (!token) {
      log('rejected: no session cookie', { ip });
      abortHandshake(socket, 401);
      return;
    }

    // 3. Validate session + admin.
    const session = await validateSession(token);
    if (!session) {
      // Accept the WS only to send a clean close code the UI can read.
      acceptThenClose(req, socket, head, 4401, 'unauthorized', ip);
      return;
    }
    if (!session.isAdmin) {
      log('rejected: not admin', { ip, user: session.username });
      acceptThenClose(req, socket, head, 4403, 'forbidden', ip);
      return;
    }

    // 4. Authenticated — accept the WS and spawn the PTY.
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleSession(ws, session.username, ip);
    });
  })().catch((err) => {
    log('upgrade handler error', {
      error: err instanceof Error ? err.message : String(err),
    });
    try {
      abortHandshake(socket, 500);
    } catch {
      /* socket already gone */
    }
  });
});

// ---------------------------------------------------------------------------
// Startup banner / config sanity (reads dashboard.env values from env)
// ---------------------------------------------------------------------------

function startupCheck() {
  // Touch dbConfig so a missing DB_PASSWORD fails fast at boot, not on first WS.
  try {
    dbConfig();
  } catch (err) {
    log('FATAL: db config invalid', {
      error: err instanceof Error ? err.message : String(err),
    });
    fatal('db config invalid', 1);
    return false;
  }
  if (!ALLOWED_ORIGIN) {
    log('WARNING: ALLOWED_ORIGIN is not set; cross-site WS protection disabled');
  }
  return true;
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('shutdown', { signal });
  wss.clients.forEach((client) => {
    try {
      client.close(1012, 'server restarting');
    } catch {
      client.terminate();
    }
  });
  shutdownTimer = setTimeout(() => fatal('shutdown timeout', 0), 5000).unref();
  wss.close(() => {
    httpServer.close(() => fatal('graceful shutdown complete', 0));
  });
}

function main() {
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  // Never let an unexpected error take the whole sidecar down silently.
  process.on('uncaughtException', (err) => {
    log('uncaughtException', { error: err.message });
  });
  process.on('unhandledRejection', (reason) => {
    log('unhandledRejection', { reason: String(reason) });
  });

  if (startupCheck()) {
    httpServer.listen(PORT, HOST, () => {
      log('listening', {
        host: HOST,
        port: PORT,
        shell: SHELL,
        idleSec: IDLE_SEC,
        originEnforced: Boolean(ALLOWED_ORIGIN),
      });
    });
  }
}

// Only start the server when run directly (`node src/server.js`), not when
// imported by tests. Mirrors the guard in cortex-mail-guardian's entrypoint.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
