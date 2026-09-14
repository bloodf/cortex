import { describe, it, expect } from 'vitest';
import { parseRawEmail } from '../src/imap.js';

const CRLF = '\r\n';

describe('parseRawEmail body extraction', () => {
  it('decodes a base64 text/plain part of a multipart message', async () => {
    const body = Buffer.from('Hello,\n\nYour invoice is ready.\n', 'utf8').toString('base64');
    const raw = [
      'From: Billing <billing@example.com>',
      'Subject: Your invoice #4821 is ready',
      'Content-Type: multipart/alternative; boundary="B1"',
      '',
      '--B1',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      body,
      '--B1',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>ignored html</p>',
      '--B1--',
      '',
    ].join(CRLF);

    const msg = await parseRawEmail(raw);
    expect(msg.subject).toBe('Your invoice #4821 is ready');
    expect(msg.bodyText).toContain('Your invoice is ready.');
    expect(msg.bodyText).not.toContain('B1');
    expect(msg.bodyText).not.toContain('Content-Transfer-Encoding');
  });

  it('captures the html part verbatim alongside text/plain', async () => {
    const raw = [
      'Subject: Both parts',
      'Content-Type: multipart/alternative; boundary="B1"',
      '',
      '--B1',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Plain body',
      '--B1',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>HTML <strong>body</strong></p>',
      '--B1--',
      '',
    ].join(CRLF);
    const msg = await parseRawEmail(raw);
    expect(msg.bodyText).toContain('Plain body');
    expect(msg.bodyHtml).toContain('<p>HTML <strong>body</strong></p>');
  });

  it('walks nested multipart/related → multipart/alternative for html', async () => {
    // Real-world shape: outer multipart/related wraps an inner
    // multipart/alternative (plain + html) plus an embedded image part.
    // The hand-rolled parser only split the outer boundary and never saw the
    // html branch inside the alternative. mailparser walks the tree.
    const raw = [
      'From: Marketing <promo@example.com>',
      'Subject: nested MIME',
      'Content-Type: multipart/related; boundary="OUTER"',
      '',
      '--OUTER',
      'Content-Type: multipart/alternative; boundary="INNER"',
      '',
      '--INNER',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'fallback text',
      '--INNER',
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      '<p>Hello=2C <b>world</b></p>',
      '--INNER--',
      '--OUTER',
      'Content-Type: image/png',
      'Content-Transfer-Encoding: base64',
      'Content-ID: <logo@example.com>',
      '',
      'iVBORw0KGgo=',
      '--OUTER--',
      '',
    ].join(CRLF);
    const msg = await parseRawEmail(raw);
    expect(msg.bodyText).toContain('fallback text');
    expect(msg.bodyHtml).toContain('<b>world</b>');
    // The base64 image blob must not leak into the body fields.
    expect(msg.bodyText).not.toContain('iVBORw0KGgo');
    expect(msg.bodyHtml).not.toContain('iVBORw0KGgo');
  });

  it('falls back to a tag-stripped html part when there is no text/plain', async () => {
    const raw = [
      'Subject: HTML only',
      'Content-Type: multipart/alternative; boundary="X"',
      '',
      '--X',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<html><body><p>Click <a href="http://x">here</a></p></body></html>',
      '--X--',
      '',
    ].join(CRLF);
    const msg = await parseRawEmail(raw);
    expect(msg.bodyText).toContain('Click');
    expect(msg.bodyText).toContain('here');
    expect(msg.bodyText).not.toContain('<');
  });

  it('decodes quoted-printable single-part bodies', async () => {
    const raw = [
      'Subject: QP',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'Caf=C3=A9 =E2=82=AC10 due=',
      ' now',
      '',
    ].join(CRLF);
    const msg = await parseRawEmail(raw);
    expect(msg.bodyText).toContain('Café');
    expect(msg.bodyText).toContain('€10');
  });

  it('leaves bodyText undefined for an empty body', async () => {
    const raw = ['Subject: Empty', 'Content-Type: text/plain', '', ''].join(CRLF);
    const msg = await parseRawEmail(raw);
    expect(msg.bodyText).toBeUndefined();
  });
});
