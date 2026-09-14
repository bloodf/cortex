import { createHash } from 'node:crypto';

export interface RedactedEmail {
  fromHash: string;
  domainHash: string;
  subjectHash: string;
  bodyHash: string;
  summary: string;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function senderDomain(address: string): string {
  const match = address.toLowerCase().match(/@([^>\s]+)>?$/);
  return match?.[1] ?? '';
}

export function redactEmail(input: { from: string; subject: string; text: string }): RedactedEmail {
  const normalizedText = input.text.replace(/\s+/g, ' ').trim();
  const safeWords = normalizedText
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/\b\d{4,}\b/g, '[number]')
    .split(/\s+/)
    .slice(0, 40)
    .join(' ');
  return {
    fromHash: sha256(input.from.toLowerCase()),
    domainHash: sha256(senderDomain(input.from)),
    subjectHash: sha256(input.subject),
    bodyHash: sha256(input.text),
    summary: safeWords,
  };
}
