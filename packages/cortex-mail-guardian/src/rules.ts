/**
 * Deterministic rule pre-filter layer.
 *
 * Consults the `mail_guardian_rules` table BEFORE any AI model call:
 *   - a `block` rule that matches the sender hash or domain hash short-circuits to spam
 *   - an `allow` rule that matches the sender hash or domain hash short-circuits to ham
 *   - otherwise we fall through to the AI classifier
 *
 * The live `mail_guardian_rules` table is hash-based:
 *   rule_type IN ('allow','block'), scope IN ('sender','domain'), value_hash TEXT.
 * Sender/domain values are SHA-256 hashed (see src/redact.ts) so plaintext
 * addresses never leave the host. Rules are matched against the hashes of the
 * inbound message's sender address and sender domain.
 */
import type { RedactedEmail } from './redact.js';

export type RuleVerdict = 'spam' | 'ham';

export interface RuleMatch {
  verdict: RuleVerdict;
  scope: 'sender' | 'domain';
  ruleType: 'allow' | 'block';
}

export interface RuleLookup {
  /**
   * Returns the matching rules for the given sender + domain hashes, if any.
   * `block` rules take precedence over `allow` rules; sender scope takes
   * precedence over domain scope within the same rule type.
   */
  findRules(fromHash: string, domainHash: string): Promise<RuleMatch[]>;
}

export function pickRule(matches: RuleMatch[]): RuleMatch | null {
  if (matches.length === 0) return null;
  const order = (m: RuleMatch): number => {
    const typeRank = m.ruleType === 'block' ? 0 : 1;
    const scopeRank = m.scope === 'sender' ? 0 : 1;
    return typeRank * 2 + scopeRank;
  };
  return [...matches].sort((a, b) => order(a) - order(b))[0] ?? null;
}

/**
 * Evaluate the deterministic rule layer for a redacted message.
 *
 * Returns a short-circuit verdict when a rule matches, otherwise `null` to
 * signal the caller should fall through to the AI classifier.
 *
 * Precedence: a `block` match always wins over an `allow` match (fail closed),
 * and a `sender`-scoped match wins over a `domain`-scoped match.
 */
export async function evaluateRules(
  lookup: RuleLookup,
  redacted: Pick<RedactedEmail, 'fromHash' | 'domainHash'>,
): Promise<RuleMatch | null> {
  const matches = await lookup.findRules(redacted.fromHash, redacted.domainHash);
  if (matches.length === 0) return null;
  return pickRule(matches);
}
