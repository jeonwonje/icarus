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
