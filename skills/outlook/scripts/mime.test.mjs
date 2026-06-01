import { describe, it, expect } from 'vitest';
import { parseHeaders, decodeWord, decodeBytes, splitHeaderBody, parseContentType } from './mime.mjs';

describe('parseHeaders', () => {
  it('lowercases keys and unfolds continuation lines', () => {
    const h = parseHeaders('Subject: hello\r\n world\r\nFrom: a@b.com');
    expect(h.subject).toBe('hello world');
    expect(h.from).toBe('a@b.com');
  });
});

describe('decodeWord (RFC2047)', () => {
  it('decodes B and Q encoded words and joins adjacent', () => {
    expect(decodeWord('=?UTF-8?B?SGVsbG8=?=')).toBe('Hello');
    expect(decodeWord('=?UTF-8?Q?H=C3=A9llo?=')).toBe('Héllo');
    expect(decodeWord('=?UTF-8?B?SGVs?= =?UTF-8?B?bG8=?=')).toBe('Hello');
    expect(decodeWord('plain text')).toBe('plain text');
  });
});

describe('decodeBytes', () => {
  it('decodes utf-8 and falls back on unknown charset', () => {
    expect(decodeBytes(Buffer.from('héllo', 'utf-8'), 'utf-8')).toBe('héllo');
    expect(decodeBytes(Buffer.from('hi'), 'x-unknown')).toBe('hi');
  });
});

describe('splitHeaderBody', () => {
  it('splits at the first blank line, body stays a Buffer', () => {
    const { header, body } = splitHeaderBody(Buffer.from('A: 1\r\n\r\nbody here'));
    expect(header).toBe('A: 1');
    expect(body.toString()).toBe('body here');
  });
});

describe('parseContentType', () => {
  it('parses type + quoted params', () => {
    const ct = parseContentType('multipart/mixed; boundary="==abc=="');
    expect(ct.type).toBe('multipart/mixed');
    expect(ct.params.boundary).toBe('==abc==');
  });
});
import { decodeTransfer, splitMultipart, extractFilename, parseEml, htmlToText } from './mime.mjs';

describe('decodeTransfer', () => {
  it('decodes base64 and quoted-printable', () => {
    expect(decodeTransfer(Buffer.from('SGk='), 'base64').toString()).toBe('Hi');
    expect(decodeTransfer(Buffer.from('a=3Db'), 'quoted-printable').toString()).toBe('a=b');
    expect(decodeTransfer(Buffer.from('raw'), '7bit').toString()).toBe('raw');
  });
});

describe('extractFilename', () => {
  it('pulls filename from content-disposition', () => {
    expect(extractFilename('attachment; filename="notes.pdf"')).toBe('notes.pdf');
  });
});

describe('htmlToText', () => {
  it('strips tags and decodes entities', () => {
    expect(htmlToText('<p>Hi&amp;bye</p>')).toBe('Hi&bye');
  });
});

describe('parseEml', () => {
  it('parses a plain text email', () => {
    const eml = 'Subject: =?UTF-8?B?SGk=?=\r\nFrom: a@b.com\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nbody line';
    const m = parseEml(Buffer.from(eml));
    expect(m.headers.subject).toBe('=?UTF-8?B?SGk=?='); // raw header kept; decode at use-site
    expect(m.text.trim()).toBe('body line');
  });

  it('walks multipart/mixed: text part + base64 attachment', () => {
    const b = 'BOUNDARY1';
    const eml = [
      'Content-Type: multipart/mixed; boundary="' + b + '"', '',
      '--' + b,
      'Content-Type: text/plain; charset=utf-8', '',
      'hello world', '',
      '--' + b,
      'Content-Type: application/pdf; name="x.pdf"',
      'Content-Disposition: attachment; filename="x.pdf"',
      'Content-Transfer-Encoding: base64', '',
      Buffer.from('PDFBYTES').toString('base64'), '',
      '--' + b + '--', '',
    ].join('\r\n');
    const m = parseEml(Buffer.from(eml));
    expect(m.text.trim()).toBe('hello world');
    expect(m.attachments).toHaveLength(1);
    expect(m.attachments[0].filename).toBe('x.pdf');
    expect(m.attachments[0].bytes.toString()).toBe('PDFBYTES');
  });

  it('falls back to html→text when no text/plain', () => {
    const eml = 'Content-Type: text/html; charset=utf-8\r\n\r\n<p>Hi there</p>';
    expect(parseEml(Buffer.from(eml)).text.trim()).toBe('Hi there');
  });
});
