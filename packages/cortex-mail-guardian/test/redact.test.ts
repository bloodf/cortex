import { describe, expect, it } from 'vitest';
import { redactEmail, senderDomain } from '../src/redact.js';

describe('redaction', () => {
  it('stores hashes and removes direct emails and urls from summaries', () => {
    const redacted = redactEmail({
      from: 'Sender <sales@example.com>',
      subject: 'Deal for you',
      text: 'Email recipient@example.com and visit https://example.com/path with code 123456.',
    });
    expect(redacted.fromHash).toMatch(/^[a-f0-9]{64}$/);
    expect(redacted.subjectHash).toMatch(/^[a-f0-9]{64}$/);
    expect(redacted.summary).not.toContain('recipient@example.com');
    expect(redacted.summary).not.toContain('https://example.com');
    expect(redacted.summary).toContain('[email]');
    expect(redacted.summary).toContain('[url]');
  });

  it('extracts sender domains', () => {
    expect(senderDomain('Sender <sales@example.com>')).toBe('example.com');
  });
});
