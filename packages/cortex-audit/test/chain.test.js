/**
 * Hash-chain unit tests using an in-memory pg shim.
 *
 * The shim implements the subset of pg.Pool the audit module uses:
 *   - pool.connect() → client with query/release
 *   - pool.query()   → forwards to the shared store
 *   - BEGIN/COMMIT/ROLLBACK + FOR UPDATE serialisation
 *   - the four SQL shapes the audit module sends
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  append,
  verifyChain,
  anchorToRekor,
  payloadHashOf,
  chainHashOf,
  GENESIS_PREV_HASH,
  setPool,
} from '../src/index.js';

function makeShim() {
  const rows = [];
  let nextId = 1;
  let txMutex = Promise.resolve();

  function matchInsert(text) {
    return text.includes('INSERT INTO audit_log');
  }
  function matchSelectTip(text) {
    return (
      text.includes('FROM audit_log') &&
      text.includes('ORDER BY occurred_at DESC, id DESC') &&
      text.includes('LIMIT 1') &&
      text.includes('FOR UPDATE')
    );
  }
  function matchSelectTipNoLock(text) {
    return (
      text.includes('FROM audit_log') &&
      text.includes('ORDER BY occurred_at DESC, id DESC') &&
      text.includes('LIMIT 1') &&
      !text.includes('FOR UPDATE')
    );
  }
  function matchSelectWindow(text) {
    return text.includes('FROM audit_log') && text.includes('ORDER BY occurred_at ASC, id ASC');
  }
  function matchSelectAnchorPrev(text) {
    return (
      text.includes('WHERE occurred_at < $1') && text.includes('ORDER BY occurred_at DESC, id DESC')
    );
  }
  function matchCountPending(text) {
    return text.includes('COUNT(*)::int AS c') && text.includes('rekor_log_index IS NULL');
  }
  function matchUpdateRekor(text) {
    return text.includes('UPDATE audit_log') && text.includes('SET rekor_log_index');
  }

  async function doQuery(text, params = []) {
    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };

    if (matchSelectTip(text) || matchSelectTipNoLock(text)) {
      if (rows.length === 0) return { rows: [] };
      const last = rows[rows.length - 1];
      return {
        rows: [{ chain_hash: last.chain_hash, id: last.id, occurred_at: last.occurred_at }],
      };
    }

    if (matchInsert(text)) {
      const [
        eventId,
        eventType,
        source,
        subject,
        actor,
        payloadHash,
        prevHash,
        chainHash,
        payload,
      ] = params;
      const row = {
        id: nextId,
        occurred_at: new Date(),
        event_id: eventId,
        event_type: eventType,
        source,
        subject,
        actor,
        payload_hash: payloadHash,
        prev_hash: prevHash,
        chain_hash: chainHash,
        rekor_log_index: null,
        payload,
      };
      rows.push(row);
      nextId += 1;
      return { rows: [row] };
    }

    if (matchSelectAnchorPrev(text)) {
      const before = params[0];
      const filtered = rows.filter((r) => r.occurred_at < before);
      if (filtered.length === 0) return { rows: [] };
      const last = filtered[filtered.length - 1];
      return { rows: [{ chain_hash: last.chain_hash }] };
    }

    if (matchCountPending(text)) {
      const c = rows.filter((r) => r.rekor_log_index === null).length;
      return { rows: [{ c }] };
    }

    if (matchSelectWindow(text)) {
      let result = rows.slice();
      let pIdx = 0;
      if (text.includes('occurred_at >= $')) {
        const ts = params[pIdx];
        pIdx += 1;
        result = result.filter((r) => r.occurred_at >= ts);
      }
      if (text.includes('occurred_at <  $')) {
        const ts = params[pIdx];
        pIdx += 1;
        result = result.filter((r) => r.occurred_at < ts);
      }
      return {
        rows: result.map((r) => ({
          id: r.id,
          occurred_at: r.occurred_at,
          payload_hash: r.payload_hash,
          prev_hash: r.prev_hash,
          chain_hash: r.chain_hash,
          payload: r.payload,
        })),
      };
    }

    if (matchUpdateRekor(text)) {
      const [logIndex, occurredAt, id] = params;
      const r = rows.find((x) => x.id === id && x.occurred_at === occurredAt);
      if (r) r.rekor_log_index = logIndex;
      return { rows: [] };
    }

    throw new Error(`shim: unhandled query: ${text}`);
  }

  const client = {
    query: doQuery,
    release() {},
  };

  return {
    rows,
    async connect() {
      // Serialise to mimic FOR UPDATE locking across appends.
      let release;
      const prior = txMutex;
      txMutex = new Promise((r) => {
        release = r;
      });
      await prior;
      const wrapped = { ...client, release: () => release() };
      return wrapped;
    },
    query: doQuery,
  };
}

let shim;
beforeEach(() => {
  shim = makeShim();
  setPool(shim);
});

describe('payloadHashOf / chainHashOf primitives', () => {
  it('payload hash is stable across key order', () => {
    expect(payloadHashOf({ a: 1, b: 2 })).toBe(payloadHashOf({ b: 2, a: 1 }));
  });

  it('chain hash composes prev + payload deterministically', () => {
    const h1 = chainHashOf(GENESIS_PREV_HASH, payloadHashOf({ x: 1 }));
    const h2 = chainHashOf(GENESIS_PREV_HASH, payloadHashOf({ x: 1 }));
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('append()', () => {
  it('first row uses GENESIS prev_hash', async () => {
    const r = await append({
      event_type: 'test.evt',
      source: 'test',
      payload: { hello: 'world' },
    });
    expect(r.prev_hash).toBe(GENESIS_PREV_HASH);
    expect(r.payload_hash).toBe(payloadHashOf({ hello: 'world' }));
    expect(r.chain_hash).toBe(chainHashOf(r.prev_hash, r.payload_hash));
  });

  it('subsequent rows chain off the previous chain_hash', async () => {
    const r1 = await append({ event_type: 't', source: 's', payload: { n: 1 } });
    const r2 = await append({ event_type: 't', source: 's', payload: { n: 2 } });
    expect(r2.prev_hash).toBe(r1.chain_hash);
    expect(r2.chain_hash).toBe(chainHashOf(r2.prev_hash, r2.payload_hash));
  });

  it('rejects missing required fields', async () => {
    await expect(append({ source: 's', payload: {} })).rejects.toThrow(/event_type/);
    await expect(append({ event_type: 't', payload: {} })).rejects.toThrow(/source/);
    await expect(append({ event_type: 't', source: 's' })).rejects.toThrow(/payload/);
  });
});

describe('verifyChain()', () => {
  it('returns valid:true on intact chain', async () => {
    await append({ event_type: 't', source: 's', payload: { n: 1 } });
    await append({ event_type: 't', source: 's', payload: { n: 2 } });
    await append({ event_type: 't', source: 's', payload: { n: 3 } });
    const r = await verifyChain();
    expect(r.valid).toBe(true);
    expect(r.count).toBe(3);
  });

  it('detects tampered payload (payload_hash_mismatch)', async () => {
    await append({ event_type: 't', source: 's', payload: { n: 1 } });
    await append({ event_type: 't', source: 's', payload: { n: 2 } });
    shim.rows[1].payload = { n: 999 }; // tamper without recomputing hash
    const r = await verifyChain();
    expect(r.valid).toBe(false);
    expect(r.brokenAt.reason).toBe('payload_hash_mismatch');
  });

  it('detects tampered chain_hash (chain_hash_mismatch)', async () => {
    await append({ event_type: 't', source: 's', payload: { n: 1 } });
    await append({ event_type: 't', source: 's', payload: { n: 2 } });
    shim.rows[1].chain_hash = 'f'.repeat(64);
    const r = await verifyChain();
    expect(r.valid).toBe(false);
    expect(['chain_hash_mismatch', 'prev_hash_mismatch']).toContain(r.brokenAt.reason);
  });

  it('detects missing row via prev_hash break', async () => {
    await append({ event_type: 't', source: 's', payload: { n: 1 } });
    await append({ event_type: 't', source: 's', payload: { n: 2 } });
    await append({ event_type: 't', source: 's', payload: { n: 3 } });
    // Splice out the middle row — chain becomes inconsistent.
    shim.rows.splice(1, 1);
    const r = await verifyChain();
    expect(r.valid).toBe(false);
    expect(r.brokenAt.reason).toBe('prev_hash_mismatch');
  });

  it('returns valid:true on empty window', async () => {
    const r = await verifyChain();
    expect(r).toEqual({ valid: true, count: 0 });
  });
});

describe('anchorToRekor()', () => {
  it('no-ops when nothing pending', async () => {
    const r = await anchorToRekor(undefined, {
      anchorFn: async () => ({ logIndex: 1, uuid: 'x' }),
    });
    expect(r.anchored).toBe(false);
  });

  it('anchors tip and backfills rekor_log_index', async () => {
    await append({ event_type: 't', source: 's', payload: { n: 1 } });
    await append({ event_type: 't', source: 's', payload: { n: 2 } });
    const r = await anchorToRekor(undefined, {
      anchorFn: async (digest) => {
        expect(digest).toMatch(/^[0-9a-f]{64}$/);
        return { logIndex: 4242, uuid: 'abc' };
      },
    });
    expect(r.anchored).toBe(true);
    expect(r.rekorLogIndex).toBe(4242);
    // Only the tip row should carry the log index.
    expect(shim.rows.filter((x) => x.rekor_log_index !== null)).toHaveLength(1);
    expect(shim.rows[shim.rows.length - 1].rekor_log_index).toBe(4242);
  });
});
