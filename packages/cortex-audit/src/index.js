/**
 * @cortexos/audit — hash-chained, Rekor-anchored audit log.
 *
 * Public API:
 *   append(event, opts?)             → inserts a new audit row; returns row
 *   verifyChain(fromTs, toTs, opts?) → recomputes the chain across a window
 *   anchorToRekor(batchSinceTs, opts?) → anchors latest tip into Rekor
 *   getPool() / setPool()            → DI for tests / shared dashboard pool
 *
 * Concurrency model:
 *   `append()` runs inside a transaction. It takes a row-level lock on the
 *   most recent existing row (`FOR UPDATE`) so two concurrent writers
 *   serialise on the chain tip rather than racing to compute `prev_hash`.
 *   The chain is therefore strict-serialisable at the database level.
 *
 * Trade-offs (documented in docs/AUDIT.md):
 *   - `append()` failure MUST NOT block the originating operation. Callers
 *     wrap it in try/catch and emit local dashboard/journald evidence on
 *     failure. Continuity of the production path beats absolute completeness
 *     of the audit trail; gaps are observable via `verifyChain`.
 */
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import jcs from './jcs.js';
import anchorDigest from './rekor.js';
import { dbPassword, dbHost, dbPort, dbName, dbUser } from './env.js';

const GENESIS_PREV_HASH = '0'.repeat(64);

let injectedPool = null;

/**
 * Inject a pg.Pool (used by the dashboard so we share its pool).
 * @param {pg.Pool} pool
 * @returns {void}
 */
export function setPool(pool) {
  injectedPool = pool;
}

/** Lazy default pool — env-driven, mirrors dashboard/src/lib/db/client.ts. */
function defaultPool() {
  const password = dbPassword();
  if (!password) {
    throw new Error('DB_PASSWORD environment variable is required');
  }
  return new pg.Pool({
    host: dbHost() || '127.0.0.1',
    port: parseInt(dbPort() || '5432', 10),
    database: dbName() || 'cortex_dashboard',
    user: dbUser() || 'dashboard',
    password,
  });
}

let lazyPool = null;
/**
 * @returns {pg.Pool}
 */
export function getPool() {
  if (injectedPool) return injectedPool;
  if (!lazyPool) lazyPool = defaultPool();
  return lazyPool;
}

function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Compute the canonical payload hash (SHA-256 over JCS-canonical JSON).
 * @param {unknown} payload
 * @returns {string}
 */
export function payloadHashOf(payload) {
  return sha256Hex(jcs(payload));
}

/**
 * Compute the chain hash from prev_hash + payload_hash (both hex).
 * @param {string} prevHashHex
 * @param {string} payloadHashHex
 * @returns {string}
 */
export function chainHashOf(prevHashHex, payloadHashHex) {
  return sha256Hex(
    Buffer.concat([Buffer.from(prevHashHex, 'hex'), Buffer.from(payloadHashHex, 'hex')]),
  );
}

/**
 * Append an audit row.
 *
 * @param {object} event
 * @param {string} event.event_type   e.g. "cortex.dashboard.helper.exec"
 * @param {string} event.source       e.g. "cortex-dashboard-root-helper"
 * @param {string} [event.subject]    e.g. issueId / runId
 * @param {string} [event.actor]      e.g. user/agent identifier
 * @param {object} event.payload      free-form JSON, canonicalised for hashing
 * @param {string} [event.event_id]   optional UUID (auto-generated otherwise)
 * @param {object} [opts]
 * @param {pg.Pool|pg.Client} [opts.pool]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function append(event, opts = {}) {
  if (!event || typeof event !== 'object') throw new Error('append: event required');
  if (!event.event_type) throw new Error('append: event_type required');
  if (!event.source) throw new Error('append: source required');
  if (event.payload === undefined || event.payload === null) {
    throw new Error('append: payload required');
  }

  const pool = opts.pool || getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the current tip so concurrent appends serialise. ORDER BY
    // (occurred_at, id) DESC matches the PK and is therefore an index scan.
    const tip = await client.query(
      `SELECT chain_hash
         FROM audit_log
        ORDER BY occurred_at DESC, id DESC
        LIMIT 1
        FOR UPDATE`,
    );
    const prevHash = tip.rows[0]?.chain_hash || GENESIS_PREV_HASH;

    const eventId = event.event_id || randomUUID();
    const payloadHash = payloadHashOf(event.payload);
    const chainHash = chainHashOf(prevHash, payloadHash);

    const insert = await client.query(
      `INSERT INTO audit_log
         (event_id, event_type, source, subject, actor,
          payload_hash, prev_hash, chain_hash, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, occurred_at, event_id, event_type, source, subject,
                 actor, payload_hash, prev_hash, chain_hash, rekor_log_index,
                 payload`,
      [
        eventId,
        event.event_type,
        event.source,
        event.subject ?? null,
        event.actor ?? null,
        payloadHash,
        prevHash,
        chainHash,
        event.payload,
      ],
    );

    await client.query('COMMIT');
    return insert.rows[0];
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Verify the hash chain between two timestamps (inclusive of `fromTs`,
 * exclusive of `toTs` if provided). Returns:
 *   { valid: true, count, firstId, lastId }                              — when intact
 *   { valid: false, count, brokenAt: { id, occurred_at, reason }, ... }  — when broken
 *
 * If `fromTs` is omitted, verifies from genesis.
 * If the window is empty, returns { valid: true, count: 0 }.
 * @param {Date|undefined} fromTs
 * @param {Date|undefined} toTs
 * @param {{pool?: pg.Pool|pg.Client}} [opts]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function verifyChain(fromTs, toTs, opts = {}) {
  const pool = opts.pool || getPool();
  const where = [];
  const params = [];
  if (fromTs) {
    params.push(fromTs);
    where.push(`occurred_at >= $${params.length}`);
  }
  if (toTs) {
    params.push(toTs);
    where.push(`occurred_at <  $${params.length}`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const { rows } = await pool.query(
    `SELECT id, occurred_at, payload_hash, prev_hash, chain_hash, payload
       FROM audit_log
       ${whereSql}
      ORDER BY occurred_at ASC, id ASC`,
    params,
  );

  if (rows.length === 0) return { valid: true, count: 0 };

  // Anchor: prev_hash of the first row in the window must equal the
  // chain_hash of the row immediately preceding it (or GENESIS if there is
  // none). This catches deletion/insertion at the window's left edge.
  let expectedPrev;
  if (fromTs) {
    const anchor = await pool.query(
      `SELECT chain_hash
         FROM audit_log
        WHERE occurred_at < $1
        ORDER BY occurred_at DESC, id DESC
        LIMIT 1`,
      [fromTs],
    );
    expectedPrev = anchor.rows[0]?.chain_hash || GENESIS_PREV_HASH;
  } else {
    expectedPrev = GENESIS_PREV_HASH;
  }

  // Walk the window sequentially as a reduce-over-promises so ordering is
  // preserved by construction (each row is folded before the next begins) and
  // the code stays lint-clean under `no-restricted-syntax` (no `for...of`).
  const verification = await rows.reduce(
    async (accPromise, row) => {
      const acc = await accPromise;
      if (!acc.valid) return acc;
      if (row.prev_hash !== acc.expectedPrev) {
        return {
          valid: false,
          count: rows.length,
          brokenAt: { id: row.id, occurred_at: row.occurred_at, reason: 'prev_hash_mismatch' },
        };
      }
      const recomputedPayload = payloadHashOf(row.payload);
      if (recomputedPayload !== row.payload_hash) {
        return {
          valid: false,
          count: rows.length,
          brokenAt: { id: row.id, occurred_at: row.occurred_at, reason: 'payload_hash_mismatch' },
        };
      }
      const recomputedChain = chainHashOf(row.prev_hash, row.payload_hash);
      if (recomputedChain !== row.chain_hash) {
        return {
          valid: false,
          count: rows.length,
          brokenAt: { id: row.id, occurred_at: row.occurred_at, reason: 'chain_hash_mismatch' },
        };
      }
      return { ...acc, expectedPrev: row.chain_hash };
    },
    Promise.resolve({ valid: true, expectedPrev }),
  );

  if (!verification.valid) return verification;

  return {
    valid: true,
    count: rows.length,
    firstId: rows[0].id,
    lastId: rows[rows.length - 1].id,
  };
}

/**
 * Anchor the most recent chain head into Rekor and backfill `rekor_log_index`
 * on the anchored row.
 *
 * Anchor-by-tip semantics: a single Rekor entry covers every row up to and
 * including the tip; only the tip row is stamped with `rekor_log_index`.
 *
 * `batchSinceTs` is informational — it constrains which rows count as
 * "needing anchor" for the no-op short-circuit, but the actual anchor is
 * always against the latest tip.
 * @param {Date|undefined} batchSinceTs
 * @param {{pool?: pg.Pool|pg.Client, anchorFn?: (hash: string) => Promise<{logIndex: number, uuid: string}>}} [opts]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function anchorToRekor(batchSinceTs, opts = {}) {
  const pool = opts.pool || getPool();
  const anchorFn = opts.anchorFn || anchorDigest;

  const pendingParams = batchSinceTs ? [batchSinceTs] : [];
  const pendingWhere = batchSinceTs ? 'AND occurred_at >= $1' : '';
  const { rows: pending } = await pool.query(
    `SELECT COUNT(*)::int AS c
       FROM audit_log
      WHERE rekor_log_index IS NULL
      ${pendingWhere}`,
    pendingParams,
  );
  if (pending[0].c === 0) {
    return { anchored: false, reason: 'no_pending_rows' };
  }

  const { rows: tipRows } = await pool.query(
    `SELECT id, occurred_at, chain_hash
       FROM audit_log
      ORDER BY occurred_at DESC, id DESC
      LIMIT 1`,
  );
  if (tipRows.length === 0) return { anchored: false, reason: 'empty_table' };
  const tip = tipRows[0];

  if (tip.chain_hash && /^[0-9a-f]{64}$/i.test(tip.chain_hash) === false) {
    throw new Error('anchorToRekor: tip chain_hash is not 64 hex chars');
  }

  const { logIndex, uuid } = await anchorFn(tip.chain_hash);

  await pool.query(
    `UPDATE audit_log
        SET rekor_log_index = $1
      WHERE occurred_at = $2 AND id = $3`,
    [logIndex, tip.occurred_at, tip.id],
  );

  return {
    anchored: true,
    tipId: tip.id,
    tipChainHash: tip.chain_hash,
    rekorLogIndex: logIndex,
    rekorUuid: uuid,
  };
}

export { GENESIS_PREV_HASH };
