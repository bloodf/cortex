import crypto from 'node:crypto';
import path from 'node:path';

const WORKSPACE_PREFIX = 'dir';
const MAX_NAME_LEN = 64;

/**
 * Derive a stable Hindsight bank id from an absolute directory path.
 * Copied from @cortexos/hindsight-memory-mcp to avoid a cross-package build dep.
 * Bank ids must match `^[a-zA-Z0-9_-]{1,64}$`.
 */
export default function deriveBankId(cwd: string): string {
  const absolute = path.resolve(cwd);
  const hash = crypto.createHash('sha256').update(absolute).digest('base64url').slice(0, 32);
  const base = path.basename(absolute) || 'root';
  const safeBase = base.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 24);
  const name = `${WORKSPACE_PREFIX}-${safeBase}-${hash}`;
  return name.slice(0, MAX_NAME_LEN);
}
