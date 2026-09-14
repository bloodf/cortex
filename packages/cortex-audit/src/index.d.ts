/**
 * Type declarations for @cortexos/audit.
 */
import type { Pool } from "pg";

export const GENESIS_PREV_HASH: string;

export function setPool(pool: Pool): void;
export function getPool(): Pool;

export function payloadHashOf(payload: unknown): string;
export function chainHashOf(prevHashHex: string, payloadHashHex: string): string;

export interface AppendOptions {
  pool?: Pool;
  occurredAt?: Date | string;
}

export interface AuditRow {
  id: string;
  occurred_at: string;
  payload_hash: string;
  prev_hash: string;
  chain_hash: string;
  payload: unknown;
}

export function append(event: unknown, opts?: AppendOptions): Promise<AuditRow>;

export interface VerifyChainOptions {
  pool?: Pool;
}

export interface VerifyChainResult {
  valid: boolean;
  count: number;
  firstId?: string;
  lastId?: string;
  brokenAt?: {
    id: string;
    occurred_at: string;
    reason: string;
  };
}

export function verifyChain(
  fromTs?: Date | string,
  toTs?: Date | string,
  opts?: VerifyChainOptions,
): Promise<VerifyChainResult>;

export interface AnchorOptions {
  pool?: Pool;
  rekorUrl?: string;
}

export function anchorToRekor(
  batchSinceTs?: Date | string,
  opts?: AnchorOptions,
): Promise<unknown>;
