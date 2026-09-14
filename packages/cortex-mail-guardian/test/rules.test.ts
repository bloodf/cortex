import { describe, expect, it } from 'vitest';
import { evaluateRules, pickRule, type RuleLookup, type RuleMatch } from '../src/rules.js';

function lookup(matches: RuleMatch[]): RuleLookup {
  return { findRules: async () => matches };
}

const redacted = { fromHash: 'from-hash', domainHash: 'domain-hash' };

describe('rule pre-filter', () => {
  it('returns null when no rule matches (fall through to AI)', async () => {
    expect(await evaluateRules(lookup([]), redacted)).toBeNull();
  });

  it('short-circuits to spam on a block rule', async () => {
    const match = await evaluateRules(
      lookup([{ verdict: 'spam', scope: 'sender', ruleType: 'block' }]),
      redacted,
    );
    expect(match?.verdict).toBe('spam');
  });

  it('short-circuits to ham on an allow rule', async () => {
    const match = await evaluateRules(
      lookup([{ verdict: 'ham', scope: 'domain', ruleType: 'allow' }]),
      redacted,
    );
    expect(match?.verdict).toBe('ham');
  });

  it('prefers block over allow (fail closed)', () => {
    const picked = pickRule([
      { verdict: 'ham', scope: 'sender', ruleType: 'allow' },
      { verdict: 'spam', scope: 'domain', ruleType: 'block' },
    ]);
    expect(picked?.ruleType).toBe('block');
  });

  it('prefers sender scope over domain scope within the same rule type', () => {
    const picked = pickRule([
      { verdict: 'ham', scope: 'domain', ruleType: 'allow' },
      { verdict: 'ham', scope: 'sender', ruleType: 'allow' },
    ]);
    expect(picked?.scope).toBe('sender');
  });
});
