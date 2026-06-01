import { describe, it, expect } from 'vitest';
import { sanitizeName, slug } from './sync.mjs';
import { parseAddress, addressList, isInternal, isBulk, deadlineHit, extractLinks, classifySignals } from './sync.mjs';
import { sha256, toIso, normalizeMessage, messageRelPath, renderMessageMarkdown } from './sync.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadManifest, shouldTriage, writeReadOnly, storeAttachment } from './sync.mjs';
import { resolveHubDir, newestPst, deriveSelf } from './sync.mjs';

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
    expect(isBulk({ from: 'noreply-nusfastpay@nus.edu.sg' })).toBe(true); // prefix, real NUS sender
    expect(isBulk({ from: 'DoNotReply.billing@x.com' })).toBe(true);
    expect(isBulk({ from: 'prof@nus.edu.sg' })).toBe(false);
    expect(isBulk({ from: 'norbert@nus.edu.sg' })).toBe(false); // \b guard: not a no-reply
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
  it('gen-id distinguishes distinct bodies sharing from/date/subject', () => {
    const base = { headers: { from: 'a@b', subject: 's', date: '' }, attachments: [] };
    const a = normalizeMessage({ ...base, text: 'first body' });
    const b = normalizeMessage({ ...base, text: 'second body' });
    expect(a.messageId).not.toBe(b.messageId);
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

const DAY = 86400000;

describe('loadManifest', () => {
  it('returns an empty manifest on missing file', () => {
    expect(loadManifest('/no/such/file.json')).toEqual({ baseline: null, lastRun: null, messages: {} });
  });
});

describe('shouldTriage', () => {
  const now = Date.parse('2026-06-02T00:00:00Z');
  const mk = (iso) => ({ date: iso });
  it('first run: triages last 40 days, drops bulk and older', () => {
    const fresh = { baseline: null, lastRun: null, messages: {} };
    expect(shouldTriage(mk('2026-05-20T00:00:00Z'), { bulk: false }, fresh, 40 * DAY, now)).toBe(true);
    expect(shouldTriage(mk('2026-01-01T00:00:00Z'), { bulk: false }, fresh, 40 * DAY, now)).toBe(false);
    expect(shouldTriage(mk('2026-05-20T00:00:00Z'), { bulk: true }, fresh, 40 * DAY, now)).toBe(false);
  });
  it('later run: triages only mail after lastRun', () => {
    const man = { baseline: '2026-04-01T00:00:00Z', lastRun: '2026-06-01T00:00:00Z', messages: {} };
    expect(shouldTriage(mk('2026-06-01T12:00:00Z'), { bulk: false }, man, 40 * DAY, now)).toBe(true);
    expect(shouldTriage(mk('2026-05-30T00:00:00Z'), { bulk: false }, man, 40 * DAY, now)).toBe(false);
  });
});

describe('writeReadOnly + storeAttachment', () => {
  it('writes 0444 and dedups identical bytes by hash', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outlook-test-'));
    const f = path.join(dir, 'x.txt');
    await writeReadOnly(f, Buffer.from('hi'));
    expect(fs.statSync(f).mode & 0o222).toBe(0); // no write bits
    const a = { filename: 'doc.pdf', bytes: Buffer.from('SAME'), contentType: 'application/pdf' };
    const n1 = await storeAttachment(dir, a);
    const n2 = await storeAttachment(dir, { ...a, filename: 'other.pdf' });
    expect(n1).toBe(n2); // identical bytes → one file
    expect(n1.endsWith('.pdf')).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('resolveHubDir', () => {
  it('walks up to a dir containing CLAUDE.md', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-'));
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '#');
    const deep = path.join(root, 'a', 'b');
    fs.mkdirSync(deep, { recursive: true });
    expect(resolveHubDir(undefined, deep)).toBe(fs.realpathSync(root));
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('newestPst / deriveSelf', () => {
  it('picks the .pst and derives the self address from its name', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pst-'));
    const p = path.join(dir, 'me@u.nus.edu.pst');
    fs.writeFileSync(p, 'x');
    expect(newestPst(dir)).toBe(p);
    expect(deriveSelf(p)).toBe('me@u.nus.edu');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

import { syncOutlook } from './sync.mjs';

// A fake converter that drops two .eml files into the temp dir readpst would fill.
function fakeConvert(eml1, eml2) {
  return async (_pstPath, outDir) => {
    fs.writeFileSync(path.join(outDir, '1.eml'), eml1);
    fs.mkdirSync(path.join(outDir, 'Inbox'), { recursive: true });
    fs.writeFileSync(path.join(outDir, 'Inbox', '2.eml'), eml2);
  };
}

describe('syncOutlook', () => {
  const now = Date.parse('2026-06-02T00:00:00Z');
  const recent = 'Message-ID: <a@x>\r\nDate: Mon, 01 Jun 2026 09:00:00 +0800\r\nFrom: prof@nus.edu.sg\r\nTo: me@u.nus.edu\r\nSubject: Submission deadline\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nplease submit by friday';
  const bulk = 'Message-ID: <b@x>\r\nDate: Mon, 01 Jun 2026 09:00:00 +0800\r\nFrom: no-reply@news.com\r\nList-Id: <n>\r\nTo: me@u.nus.edu\r\nSubject: Weekly news\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nhello';

  it('first run: stores both, triages the direct one, not the bulk one', async () => {
    const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-'));
    const s = await syncOutlook({ hubDir: hub, pstPath: '/x.pst', selfAddrs: ['me@u.nus.edu'],
      now, convert: fakeConvert(recent, bulk) });
    expect(s.messages).toBe(2);
    expect(s.triaged).toBe(1);
    const triage = JSON.parse(fs.readFileSync(path.join(hub, 'email', '.triage.json'), 'utf-8'));
    expect(triage.candidates).toHaveLength(1);
    expect(triage.candidates[0].subject).toBe('Submission deadline');
    const man = JSON.parse(fs.readFileSync(path.join(hub, 'email', '.email-manifest.json'), 'utf-8'));
    expect(man.baseline).not.toBeNull();
    expect(Object.keys(man.messages)).toHaveLength(2);
    expect(fs.existsSync(path.join(hub, 'email', '2026'))).toBe(true);
    fs.rmSync(hub, { recursive: true, force: true });
  });

  it('second run: re-seen Message-IDs are skipped, not re-written', async () => {
    const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-'));
    await syncOutlook({ hubDir: hub, pstPath: '/x.pst', selfAddrs: ['me@u.nus.edu'], now, convert: fakeConvert(recent, bulk) });
    const s2 = await syncOutlook({ hubDir: hub, pstPath: '/x.pst', selfAddrs: ['me@u.nus.edu'],
      now: now + 86400000, convert: fakeConvert(recent, bulk) });
    expect(s2.messages).toBe(0);
    expect(s2.skipped).toBe(2);
    fs.rmSync(hub, { recursive: true, force: true });
  });

  it('always removes the temp dir', async () => {
    const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-'));
    let captured;
    await syncOutlook({ hubDir: hub, pstPath: '/x.pst', selfAddrs: ['me@u.nus.edu'], now,
      convert: async (_p, outDir) => { captured = outDir; fs.writeFileSync(path.join(outDir, '1.eml'), recent); } });
    expect(fs.existsSync(captured)).toBe(false);
    fs.rmSync(hub, { recursive: true, force: true });
  });
});
