import { describe, expect, it } from 'vitest';
import { applyNamespacePrefix, parseNamespacePrefix, uniqueSearchUid } from '../src/imap.js';

describe('parseNamespacePrefix', () => {
  it('extracts the INBOX. personal prefix from a Dovecot NAMESPACE response', () => {
    // The exact shape mail.example.test returns.
    const out = '* NAMESPACE (("INBOX." ".")) NIL NIL\r\nA0002 OK NAMESPACE completed.\r\n';
    expect(parseNamespacePrefix(out)).toBe('INBOX.');
  });

  it('returns undefined when the personal namespace prefix is empty', () => {
    // A root personal namespace needs no prefixing.
    const out = '* NAMESPACE (("" "/")) NIL NIL\r\nA0002 OK NAMESPACE completed.\r\n';
    expect(parseNamespacePrefix(out)).toBeUndefined();
  });

  it('returns undefined when there is no NAMESPACE line', () => {
    expect(parseNamespacePrefix('A0002 OK done\r\n')).toBeUndefined();
  });
});

describe('uniqueSearchUid', () => {
  it('returns one UID and rejects duplicate Message-ID matches', () => {
    expect(uniqueSearchUid('* SEARCH 42\r\nA0001 OK done\r\n')).toBe(42);
    expect(uniqueSearchUid('* SEARCH\r\nA0001 OK done\r\n')).toBeUndefined();
    expect(() => uniqueSearchUid('* SEARCH 42 43\r\nA0001 OK done\r\n')).toThrow(
      /ambiguous Message-ID/,
    );
  });
});

describe('applyNamespacePrefix', () => {
  it('prefixes a bare mailbox name with the personal namespace', () => {
    // The exact failing case: SELECT "Trash" / "Cortex Mail Guardian Review"
    // was rejected with "prefix with INBOX.".
    expect(applyNamespacePrefix('Trash', 'INBOX.')).toBe('INBOX.Trash');
    expect(applyNamespacePrefix('Cortex Mail Guardian Review', 'INBOX.')).toBe(
      'INBOX.Cortex Mail Guardian Review',
    );
  });

  it('leaves already-prefixed names untouched (idempotent)', () => {
    expect(applyNamespacePrefix('INBOX.Trash', 'INBOX.')).toBe('INBOX.Trash');
    expect(applyNamespacePrefix('INBOX.Cortex Mail Guardian Review', 'INBOX.')).toBe(
      'INBOX.Cortex Mail Guardian Review',
    );
  });

  it('never prefixes INBOX itself', () => {
    expect(applyNamespacePrefix('INBOX', 'INBOX.')).toBe('INBOX');
  });

  it('is a no-op when the server has no personal prefix', () => {
    expect(applyNamespacePrefix('Trash', undefined)).toBe('Trash');
    expect(applyNamespacePrefix('INBOX.Trash', undefined)).toBe('INBOX.Trash');
  });
});
