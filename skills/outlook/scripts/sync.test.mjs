import { describe, it, expect } from 'vitest';
import { sanitizeName, slug } from './sync.mjs';
import { parseAddress, addressList, isInternal, isBulk, deadlineHit, extractLinks, classifySignals } from './sync.mjs';
import { sha256, toIso, normalizeMessage, messageRelPath, renderMessageMarkdown } from './sync.mjs';

describe('sanitizeName', () => {
  it('strips separators and control chars, never returns . or ..', () => {
    expect(sanitizeName('a/b\\c')).toBe('a_b_c');
    expect(sanitizeName('..')).toBe('file');
    expect(sanitizeName('  hi  ')).toBe('hi');
  });
});

describe('slug', () => {
  it('lowercases and dasherizes, caps length, falls back', () => {
    expect(slug('Fee Payment Deadline!')).toBe('fee-payment-deadline');
    expect(slug('   ')).toBe('untitled');
    expect(slug('a'.repeat(80)).length).toBeLessThanOrEqual(60);
  });
});

describe('address parsing', () => {
  it('extracts a bare address and a list', () => {
    expect(parseAddress('Jeon <a@b.com>')).toBe('a@b.com');
    expect(addressList('A <a@x.com>, b@y.com')).toEqual(['a@x.com', 'b@y.com']);
  });
});

describe('isInternal / isBulk', () => {
  it('flags nus.edu senders as internal', () => {
    expect(isInternal('Reg <registrar@nus.edu.sg>')).toBe(true);
    expect(isInternal('x@gmail.com')).toBe(false);
  });
  it('flags list/no-reply/precedence-bulk as bulk', () => {
    expect(isBulk({ 'list-id': '<x>' })).toBe(true);
    expect(isBulk({ precedence: 'bulk' })).toBe(true);
    expect(isBulk({ from: 'no-reply@news.com' })).toBe(true);
    expect(isBulk({ from: 'prof@nus.edu.sg' })).toBe(false);
  });
});

describe('deadlineHit / extractLinks', () => {
  it('detects deadline keywords', () => {
    expect(deadlineHit('Fee payment due', '')).toBe(true);
    expect(deadlineHit('Hi', 'just saying hello')).toBe(false);
  });
  it('extracts and dedups urls, trims trailing punctuation', () => {
    expect(extractLinks('see https://a.com/x. and https://a.com/x')).toEqual(['https://a.com/x']);
  });
});

describe('classifySignals', () => {
  const self = ['me@u.nus.edu'];
  it('marks direct mail to me with a deadline', () => {
    const msg = { headers: { to: 'me@u.nus.edu', from: 'prof@nus.edu.sg', cc: '' },
      subject: 'Submission deadline', text: 'submit by friday', attachments: [], messageId: 'm1' };
    const s = classifySignals(msg, self);
    expect(s).toMatchObject({ direct: true, cc: false, bulk: false, internal: true, deadlineHit: true, hasAttachment: false });
  });
  it('marks newsletter as bulk and not direct', () => {
    const msg = { headers: { to: 'list@x.com', from: 'no-reply@x.com', 'list-id': '<n>' },
      subject: 'Weekly', text: '', attachments: [], messageId: 'm2' };
    expect(classifySignals(msg, self).bulk).toBe(true);
  });
});

describe('normalizeMessage / messageRelPath', () => {
  it('normalizes headers, decodes subject, falls back on missing id', () => {
    const parsed = { headers: { 'message-id': '<abc@x>', date: 'Mon, 01 Jun 2026 09:12:00 +0800',
      subject: '=?UTF-8?B?SGk=?=', from: 'a@b.com' }, text: 'hi', html: '', attachments: [] };
    const m = normalizeMessage(parsed);
    expect(m.messageId).toBe('abc@x');
    expect(m.subject).toBe('Hi');
    expect(m.date).toBe('2026-06-01T01:12:00.000Z');
    expect(messageRelPath(m)).toMatch(/^2026\/2026-06-01-hi-[0-9a-f]{8}\.md$/);
  });
  it('generates an id when Message-ID is absent', () => {
    const m = normalizeMessage({ headers: { from: 'a@b', subject: 's', date: '' }, text: '', attachments: [] });
    expect(m.messageId).toMatch(/^gen-[0-9a-f]{24}$/);
  });
});

describe('renderMessageMarkdown', () => {
  it('emits frontmatter + body', () => {
    const m = { messageId: 'abc@x', date: '2026-06-01T01:12:00.000Z',
      headers: { from: 'a@b.com', to: 'me@u.nus.edu', cc: '' }, subject: 'Hi', text: 'body' };
    const md = renderMessageMarkdown(m, ['deadbeef.pdf'], ['https://x'], { direct: true });
    expect(md).toContain('message-id: "abc@x"');
    expect(md).toContain('attachments: ["deadbeef.pdf"]');
    expect(md).toContain('subject: "Hi"');
    expect(md.trimEnd().endsWith('body')).toBe(true);
  });
});
