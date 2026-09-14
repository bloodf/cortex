/**
 * Sigstore Rekor anchor helper.
 *
 * Uploads a `hashedrekord` entry containing the SHA-256 of a CortexOS
 * audit-chain head into the public-good Rekor transparency log. The
 * returned `logIndex` is then written back onto the anchored row, giving
 * external proof that the row (and its chain prefix) existed at anchor
 * time.
 *
 * We intentionally do NOT sign anchors with a long-lived key — the goal is
 * tamper-detection, not non-repudiation, and Rekor only requires that the
 * supplied signature verifies against the supplied public key.  We
 * therefore generate an ephemeral ed25519 keypair per anchor call, sign
 * the digest, upload the entry, and discard the private key. The
 * `logIndex` plus the digest are enough to later prove inclusion by
 * querying Rekor.
 */
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { request } from 'undici';
import { rekorUrl } from './env.js';

const REKOR_URL = (rekorUrl() || 'https://rekor.sigstore.dev').replace(/\/$/, '');

/**
 * Anchor a chain head digest to Rekor.
 *
 * @param {string} chainHashHex 64-char hex SHA-256 of the chain head.
 * @returns {Promise<{logIndex: number, uuid: string}>}
 */
export default async function anchorDigest(chainHashHex) {
  if (!/^[0-9a-f]{64}$/i.test(chainHashHex)) {
    throw new Error('anchorDigest: chainHashHex must be 64 hex chars');
  }

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const digestBytes = Buffer.from(chainHashHex, 'hex');
  const signature = cryptoSign(null, digestBytes, privateKey);

  const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

  const entry = {
    apiVersion: '0.0.1',
    kind: 'hashedrekord',
    spec: {
      data: {
        hash: { algorithm: 'sha256', value: chainHashHex.toLowerCase() },
      },
      signature: {
        content: signature.toString('base64'),
        publicKey: { content: Buffer.from(pubPem, 'utf8').toString('base64') },
      },
    },
  };

  const res = await request(`${REKOR_URL}/api/v1/log/entries`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json;q=1',
    },
    body: JSON.stringify(entry),
  });

  if (res.statusCode < 200 || res.statusCode >= 300) {
    const text = await res.body.text();
    throw new Error(`rekor_upload_failed status=${res.statusCode} body=${text.slice(0, 500)}`);
  }

  const body = await res.body.json();
  // Rekor returns a map keyed by entry UUID -> { logIndex, ... }
  const uuid = Object.keys(body)[0];
  if (!uuid) throw new Error('rekor_upload_no_uuid');
  const logIndex = body[uuid]?.logIndex;
  if (typeof logIndex !== 'number') throw new Error('rekor_upload_no_log_index');

  return { logIndex, uuid };
}
