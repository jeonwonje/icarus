# outlook NUS email ingest skill — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A dependency-free `outlook` Claude Code skill that ingests the operator's daily NUS `.pst` export into a read-only `<hub>/email/` mirror (year-bucketed message notes + hash-deduped attachments), dedups by `Message-ID`, and emits triage candidates that Claude curates into `index.md`.

**Architecture:** `readpst -e` converts the `.pst` to RFC822 `.eml` files in a temp dir; a pure `parseEml` (in `mime.mjs`) decodes headers + MIME; `sync.mjs` stores messages, hash-dedups attachments, maintains the manifest, computes triage signals, and writes `.triage.json`. The script does deterministic ETL only; `SKILL.md` drives Claude to make the importance call and update `index.md`. Same split + conventions as the existing `canvas` skill.

**Tech Stack:** Node `.mjs`, built-ins only (`fs`, `path`, `os`, `crypto`, `child_process`, `buffer`, global `TextDecoder`). No npm runtime deps. `readpst` (libpst) as an external system tool. Tests: vitest over `skills/**/*.test.mjs`.

**Reference:** `skills/canvas/scripts/sync.mjs` (helpers `resolveHubDir`, `sanitizeName`, `htmlToText`, `writeReadOnly`, manifest/summary patterns are reused/copied — each skill is self-contained). Spec: `docs/superpowers/specs/2026-06-02-outlook-email-skill-design.md`.

---

## File Structure

```
skills/outlook/
  SKILL.md                      # frontmatter (auto-trigger) + agent curation instructions
  scripts/
    mime.mjs                    # PURE: parseEml + RFC2047/MIME decoding helpers
    mime.test.mjs               # vitest, hand-written .eml fixtures (no readpst)
    sync.mjs                    # orchestration: readpst boundary, storage, manifest, signals, triage, main()
    sync.test.mjs               # vitest, injected converter + fs temp dirs
```

- `mime.mjs` = one responsibility: bytes of an `.eml` → `{ headers, text, html, attachments }`. No fs, no network.
- `sync.mjs` = everything stateful: hub resolution, the `readpst` shell-out (injectable), attachment hashing, manifest dedup, triage selection, summary, `main()` guard.

Reused-from-canvas helpers (`resolveHubDir`, `sanitizeName`, `htmlToText`, `writeReadOnly`) are **copied** into `sync.mjs`/`mime.mjs` so the skill is standalone (canvas did the same — no cross-skill imports).

---

## Task 1: Scaffold + first pure helper (`sanitizeName`, `slug`)

**Files:**
- Create: `skills/outlook/scripts/sync.mjs`
- Test: `skills/outlook/scripts/sync.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// skills/outlook/scripts/sync.test.mjs
import { describe, it, expect } from 'vitest';
import { sanitizeName, slug } from './sync.mjs';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run skills/outlook/scripts/sync.test.mjs`
Expected: FAIL — `Failed to resolve import './sync.mjs'`.

- [ ] **Step 3: Write minimal implementation**

```js
// skills/outlook/scripts/sync.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parseEml, decodeWord, htmlToText } from './mime.mjs';

const execFileP = promisify(execFile);

// ── path-safe naming (copied from canvas) ──────────────────────────────────
export function sanitizeName(name) {
  const s = (name ?? '').replace(/[/\\]/g, '_').replace(/\p{Cc}/gu, '').trim();
  if (s === '' || s === '.' || s === '..') return 'file';
  return s;
}

export function slug(s) {
  const out = sanitizeName(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return out || 'untitled';
}
```

(Task 3 creates `mime.mjs`; until then this import is unresolved, so run **only** the named tests in steps that don't exercise `parseEml`. Task 2 creates `mime.mjs` first — do Task 2 before re-running broad suites.)

- [ ] **Step 4: Run the two suites to verify they pass**

Run: `npx vitest run skills/outlook/scripts/sync.test.mjs -t sanitizeName && npx vitest run skills/outlook/scripts/sync.test.mjs -t slug`
Expected: PASS (the top-level `import { parseEml } from './mime.mjs'` will error until Task 2 — if so, temporarily comment that import line, run, then restore. Cleaner: do **Task 2 next**, which makes the import resolve.)

- [ ] **Step 5: Commit**

```bash
git add skills/outlook/scripts/sync.mjs skills/outlook/scripts/sync.test.mjs
git commit -m "feat(outlook): scaffold sync.mjs with sanitizeName + slug"
```

---

## Task 2: MIME — header parsing + RFC2047 encoded-word decode

**Files:**
- Create: `skills/outlook/scripts/mime.mjs`
- Test: `skills/outlook/scripts/mime.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// skills/outlook/scripts/mime.test.mjs
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run skills/outlook/scripts/mime.test.mjs`
Expected: FAIL — `Failed to resolve import './mime.mjs'`.

- [ ] **Step 3: Write minimal implementation**

```js
// skills/outlook/scripts/mime.mjs
import { Buffer } from 'node:buffer';

// ── charset decode (TextDecoder is a Node global) ──────────────────────────
export function decodeBytes(buf, charset = 'utf-8') {
  const cs = (charset || 'utf-8').toLowerCase().replace(/^["']|["']$/g, '');
  try { return new TextDecoder(cs).decode(buf); }
  catch {
    try { return new TextDecoder('utf-8').decode(buf); }
    catch { return Buffer.from(buf).toString('latin1'); }
  }
}

// ── RFC2047 encoded-word decode ────────────────────────────────────────────
export function decodeWord(s) {
  if (s == null) return '';
  return String(s)
    .replace(/\?=\s+=\?/g, '?==?') // drop whitespace between adjacent words
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, charset, enc, text) => {
      try {
        const bytes = enc.toUpperCase() === 'B'
          ? Buffer.from(text, 'base64')
          : Buffer.from(text.replace(/_/g, ' ')
              .replace(/=([0-9A-Fa-f]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16))), 'binary');
        return decodeBytes(bytes, charset);
      } catch { return text; }
    });
}

// ── header block → { lowercased-key: value } with folding unwrapped ─────────
export function parseHeaders(rawHeader) {
  const headers = {};
  const lines = String(rawHeader).replace(/\r\n/g, '\n').split('\n');
  let current = null;
  for (const line of lines) {
    if (/^[ \t]/.test(line) && current) { headers[current] += ' ' + line.trim(); continue; }
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const val = line.slice(idx + 1).trim();
    current = key;
    headers[key] = headers[key] === undefined ? val : headers[key] + '\n' + val;
  }
  return headers;
}

// ── split raw .eml Buffer into { header:string, body:Buffer } ───────────────
export function splitHeaderBody(buf) {
  const s = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  for (let i = 0; i < s.length - 1; i++) {
    if (s[i] === 0x0a) {
      if (s[i + 1] === 0x0a) return { header: s.slice(0, i).toString('utf8').trim(), body: s.slice(i + 2) };
      if (s[i + 1] === 0x0d && s[i + 2] === 0x0a) return { header: s.slice(0, i).toString('utf8').trim(), body: s.slice(i + 3) };
    }
  }
  return { header: s.toString('utf8').trim(), body: Buffer.alloc(0) };
}

export function parseContentType(value) {
  if (!value) return { type: 'text/plain', params: {} };
  const [typePart, ...rest] = value.split(';');
  const params = {};
  for (const p of rest) {
    const eq = p.indexOf('=');
    if (eq === -1) continue;
    params[p.slice(0, eq).trim().toLowerCase()] = p.slice(eq + 1).trim().replace(/^"|"$/g, '');
  }
  return { type: typePart.trim().toLowerCase(), params };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run skills/outlook/scripts/mime.test.mjs`
Expected: PASS (5 suites).

- [ ] **Step 5: Commit**

```bash
git add skills/outlook/scripts/mime.mjs skills/outlook/scripts/mime.test.mjs
git commit -m "feat(outlook): mime header + RFC2047 + content-type parsing"
```

---

## Task 3: MIME — transfer decode, multipart walk, `parseEml`

**Files:**
- Modify: `skills/outlook/scripts/mime.mjs`
- Test: `skills/outlook/scripts/mime.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// append to skills/outlook/scripts/mime.test.mjs
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run skills/outlook/scripts/mime.test.mjs`
Expected: FAIL — `decodeTransfer`/`parseEml`/`htmlToText` not exported.

- [ ] **Step 3: Write minimal implementation**

```js
// append to skills/outlook/scripts/mime.mjs

// htmlToText (copied from canvas) ───────────────────────────────────────────
export function htmlToText(html) {
  return (html ?? '')
    .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6])\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function decodeTransfer(bodyBuf, encoding) {
  const enc = (encoding || '7bit').toLowerCase();
  if (enc === 'base64') {
    return Buffer.from(bodyBuf.toString('ascii').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  }
  if (enc === 'quoted-printable') {
    const t = bodyBuf.toString('binary')
      .replace(/=\r?\n/g, '')
      .replace(/=([0-9A-Fa-f]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
    return Buffer.from(t, 'binary');
  }
  return bodyBuf;
}

export function extractFilename(disp) {
  if (!disp) return '';
  const m = String(disp).match(/filename\*?=("?)([^";]+)\1/i);
  return m ? m[2] : '';
}

export function splitMultipart(buf, boundary) {
  const delim = Buffer.from('--' + boundary);
  const positions = [];
  let idx = buf.indexOf(delim, 0);
  while (idx !== -1) { positions.push(idx); idx = buf.indexOf(delim, idx + delim.length); }
  const parts = [];
  for (let i = 0; i < positions.length - 1; i++) {
    let s = positions[i] + delim.length;
    if (buf[s] === 0x2d && buf[s + 1] === 0x2d) break; // closing "--boundary--"
    while (s < buf.length && (buf[s] === 0x0d || buf[s] === 0x0a)) s++;
    let end = positions[i + 1];
    if (buf[end - 1] === 0x0a) end--;
    if (buf[end - 1] === 0x0d) end--;
    parts.push(buf.slice(s, end));
  }
  return parts;
}

export function parseEml(buf) {
  const { header, body } = splitHeaderBody(buf);
  const headers = parseHeaders(header);
  const result = { headers, text: '', html: '', attachments: [] };
  walkPart(headers, body, result);
  if (!result.text && result.html) result.text = htmlToText(result.html);
  return result;
}

function walkPart(headers, bodyBuf, result) {
  const ct = parseContentType(headers['content-type']);
  if (ct.type.startsWith('multipart/')) {
    if (!ct.params.boundary) return;
    for (const part of splitMultipart(bodyBuf, ct.params.boundary)) {
      const { header, body } = splitHeaderBody(part);
      walkPart(parseHeaders(header), body, result);
    }
    return;
  }
  const disp = (headers['content-disposition'] || '').toLowerCase();
  const filename = ct.params.name || extractFilename(headers['content-disposition']);
  const decoded = decodeTransfer(bodyBuf, headers['content-transfer-encoding']);
  if (disp.startsWith('attachment') || (filename && !ct.type.startsWith('text/'))) {
    result.attachments.push({ filename: decodeWord(filename || 'attachment'), bytes: decoded, contentType: ct.type });
  } else if (ct.type === 'text/plain') {
    result.text += decodeBytes(decoded, ct.params.charset);
  } else if (ct.type === 'text/html') {
    result.html += decodeBytes(decoded, ct.params.charset);
  } else if (filename) {
    result.attachments.push({ filename: decodeWord(filename), bytes: decoded, contentType: ct.type });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run skills/outlook/scripts/mime.test.mjs`
Expected: PASS (all suites).

- [ ] **Step 5: Commit**

```bash
git add skills/outlook/scripts/mime.mjs skills/outlook/scripts/mime.test.mjs
git commit -m "feat(outlook): transfer decode, multipart walk, parseEml"
```

---

## Task 4: Address parsing + triage signals

**Files:**
- Modify: `skills/outlook/scripts/sync.mjs`
- Test: `skills/outlook/scripts/sync.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// append to skills/outlook/scripts/sync.test.mjs
import { parseAddress, addressList, isInternal, isBulk, deadlineHit, extractLinks, classifySignals } from './sync.mjs';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run skills/outlook/scripts/sync.test.mjs`
Expected: FAIL — exports not defined.

- [ ] **Step 3: Write minimal implementation**

```js
// append to skills/outlook/scripts/sync.mjs

export function parseAddress(v) {
  const m = (v || '').match(/<([^>]+)>/);
  return (m ? m[1] : (v || '')).trim().toLowerCase();
}
export function addressList(v) {
  return (v || '').split(',').map(parseAddress).filter(Boolean);
}
export function isInternal(from) {
  return /nus\.edu/i.test(from || '');
}

const BULK_FROM_RE = /^(no-?reply|do-?not-?reply|mailer-daemon|bounce|notifications?)@/i;
export function isBulk(headers) {
  if (headers['list-id'] || headers['list-unsubscribe']) return true;
  const prec = (headers['precedence'] || '').toLowerCase();
  if (prec === 'bulk' || prec === 'list' || prec === 'junk') return true;
  return BULK_FROM_RE.test(parseAddress(headers['from']));
}

const DEADLINE_RE = /\b(due|deadline|submit|submission|rsvp|action required|respond by|reply by|payment|overdue|expir\w*|reminder|by \w+ \d)\b/i;
export function deadlineHit(subject, body) {
  return DEADLINE_RE.test(subject || '') || DEADLINE_RE.test((body || '').slice(0, 2000));
}

export function extractLinks(text) {
  const urls = new Set();
  for (const m of (text || '').matchAll(/https?:\/\/[^\s<>"')\]]+/gi)) {
    urls.add(m[0].replace(/[.,;:]+$/, ''));
  }
  return [...urls];
}

export function classifySignals(msg, selfAddrs) {
  const self = new Set(selfAddrs.map((s) => s.toLowerCase()));
  const to = addressList(msg.headers['to']);
  const cc = addressList(msg.headers['cc']);
  const direct = to.some((a) => self.has(a));
  return {
    direct,
    cc: !direct && cc.some((a) => self.has(a)),
    bulk: isBulk(msg.headers),
    internal: isInternal(msg.headers['from']),
    calendarInvite: msg.attachments.some((a) => /\.ics$/i.test(a.filename)) || /text\/calendar/i.test(msg.headers['content-type'] || ''),
    deadlineHit: deadlineHit(msg.subject, msg.text),
    hasAttachment: msg.attachments.length > 0,
    thread: (msg.headers['references'] || '').split(/\s+/).filter(Boolean)[0] || msg.headers['in-reply-to'] || msg.messageId,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run skills/outlook/scripts/sync.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/outlook/scripts/sync.mjs skills/outlook/scripts/sync.test.mjs
git commit -m "feat(outlook): address parsing + triage signals"
```

---

## Task 5: Message normalization, paths, markdown render

**Files:**
- Modify: `skills/outlook/scripts/sync.mjs`
- Test: `skills/outlook/scripts/sync.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// append to skills/outlook/scripts/sync.test.mjs
import { sha256, toIso, normalizeMessage, messageRelPath, renderMessageMarkdown } from './sync.mjs';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run skills/outlook/scripts/sync.test.mjs`
Expected: FAIL — exports not defined.

- [ ] **Step 3: Write minimal implementation**

```js
// append to skills/outlook/scripts/sync.mjs

export function sha256(input) {
  return createHash('sha256').update(input).digest('hex');
}

export function toIso(d) {
  if (!d) return '';
  const t = new Date(d);
  return isNaN(t.getTime()) ? '' : t.toISOString();
}

export function normalizeMessage(parsed) {
  const h = parsed.headers;
  const rawId = (h['message-id'] || '').replace(/^<|>$/g, '').trim();
  const messageId = rawId || 'gen-' + sha256(`${h['from'] || ''}|${h['date'] || ''}|${h['subject'] || ''}`).slice(0, 24);
  return {
    headers: h,
    messageId,
    date: toIso(h['date']),
    subject: decodeWord(h['subject'] || '').trim(),
    text: parsed.text || '',
    attachments: parsed.attachments || [],
  };
}

export function messageRelPath(msg) {
  const date = (msg.date || '').slice(0, 10) || 'undated';
  const year = date.slice(0, 4) || 'undated';
  const h = sha256(msg.messageId).slice(0, 8);
  return `${year}/${date}-${slug(msg.subject || 'no-subject')}-${h}.md`;
}

export function renderMessageMarkdown(msg, attachmentRefs, links, signals) {
  return [
    '---',
    `message-id: ${JSON.stringify(msg.messageId)}`,
    `date: ${msg.date || 'unknown'}`,
    `from: ${JSON.stringify(decodeWord(msg.headers['from'] || ''))}`,
    `to: ${JSON.stringify(addressList(msg.headers['to']))}`,
    `cc: ${JSON.stringify(addressList(msg.headers['cc']))}`,
    `subject: ${JSON.stringify(msg.subject)}`,
    `attachments: ${JSON.stringify(attachmentRefs)}`,
    `links: ${JSON.stringify(links)}`,
    `signals: ${JSON.stringify(signals)}`,
    '---',
    '',
    (msg.text || '').trim(),
    '',
  ].join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run skills/outlook/scripts/sync.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/outlook/scripts/sync.mjs skills/outlook/scripts/sync.test.mjs
git commit -m "feat(outlook): message normalization, paths, markdown render"
```

---

## Task 6: Manifest, baseline window, read-only writes, attachment store

**Files:**
- Modify: `skills/outlook/scripts/sync.mjs`
- Test: `skills/outlook/scripts/sync.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// append to skills/outlook/scripts/sync.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadManifest, shouldTriage, writeReadOnly, storeAttachment } from './sync.mjs';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run skills/outlook/scripts/sync.test.mjs`
Expected: FAIL — exports not defined.

- [ ] **Step 3: Write minimal implementation**

```js
// append to skills/outlook/scripts/sync.mjs
const READ_ONLY = 0o444;
const OWNER_WRITE = 0o644;

export function loadManifest(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch { return { baseline: null, lastRun: null, messages: {} }; }
}

export function shouldTriage(msg, signals, manifest, windowMs, now) {
  if (signals.bulk) return false;
  const t = msg.date ? Date.parse(msg.date) : NaN;
  if (isNaN(t)) return false;
  const cutoff = manifest.baseline == null
    ? now - windowMs
    : Date.parse(manifest.lastRun || manifest.baseline);
  return t >= cutoff;
}

export async function writeReadOnly(dest, buf) {
  if (fs.existsSync(dest)) await fs.promises.chmod(dest, OWNER_WRITE);
  await fs.promises.writeFile(dest, buf);
  await fs.promises.chmod(dest, READ_ONLY);
}

function guessExt(contentType) {
  const map = { 'application/pdf': '.pdf', 'image/png': '.png', 'image/jpeg': '.jpg', 'text/calendar': '.ics' };
  return map[(contentType || '').toLowerCase()] || '.bin';
}

export async function storeAttachment(attachDir, att) {
  const hash = sha256(att.bytes);
  const ext = (path.extname(att.filename || '') || guessExt(att.contentType)).toLowerCase();
  const name = `${hash}${ext}`;
  const dest = path.join(attachDir, name);
  if (!fs.existsSync(dest)) await writeReadOnly(dest, att.bytes);
  return name;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run skills/outlook/scripts/sync.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/outlook/scripts/sync.mjs skills/outlook/scripts/sync.test.mjs
git commit -m "feat(outlook): manifest, baseline window, read-only attachment store"
```

---

## Task 7: `resolveHubDir`, `newestPst`, `deriveSelf`

**Files:**
- Modify: `skills/outlook/scripts/sync.mjs`
- Test: `skills/outlook/scripts/sync.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// append to skills/outlook/scripts/sync.test.mjs
import { resolveHubDir, newestPst, deriveSelf } from './sync.mjs';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run skills/outlook/scripts/sync.test.mjs`
Expected: FAIL — exports not defined.

- [ ] **Step 3: Write minimal implementation**

```js
// append to skills/outlook/scripts/sync.mjs (resolveHubDir copied from canvas, realpath-normalized)
export function resolveHubDir(arg, cwd = process.cwd()) {
  if (arg) return path.resolve(arg);
  let dir = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.claude')) || fs.existsSync(path.join(dir, 'CLAUDE.md'))) return fs.realpathSync(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(cwd);
}

export function newestPst(hubDir) {
  const files = fs.readdirSync(hubDir).filter((f) => f.toLowerCase().endsWith('.pst'));
  if (!files.length) return null;
  return files.map((f) => path.join(hubDir, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}

export function deriveSelf(pstPath) {
  const base = path.basename(pstPath).replace(/\.pst$/i, '');
  return /@/.test(base) ? base : '';
}
```

(Note: the canvas `resolveHubDir` returns `path.resolve(dir)`; here we `realpathSync` the match so the temp-dir test is stable on macOS/symlinked `/tmp`. Behaviorally identical in the real hub.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run skills/outlook/scripts/sync.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/outlook/scripts/sync.mjs skills/outlook/scripts/sync.test.mjs
git commit -m "feat(outlook): hub resolution, pst discovery, self-address derivation"
```

---

## Task 8: `syncOutlook` orchestration (injected converter)

**Files:**
- Modify: `skills/outlook/scripts/sync.mjs`
- Test: `skills/outlook/scripts/sync.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// append to skills/outlook/scripts/sync.test.mjs
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run skills/outlook/scripts/sync.test.mjs`
Expected: FAIL — `syncOutlook` not defined.

- [ ] **Step 3: Write minimal implementation**

```js
// append to skills/outlook/scripts/sync.mjs
const FORTY_DAYS = 40 * 86400000;

async function defaultConvert(pstPath, outDir) {
  await execFileP('readpst', ['-e', '-q', '-o', outDir, pstPath], { maxBuffer: 256 * 1024 * 1024 });
}

export function walkEmlFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkEmlFiles(full));
    else if (/\.eml$/i.test(entry.name)) out.push(full);
  }
  return out;
}

export async function syncOutlook(opts) {
  const { hubDir, pstPath, selfAddrs, windowMs = FORTY_DAYS, now = Date.now(), convert = defaultConvert } = opts;
  const emailDir = path.join(hubDir, 'email');
  const attachDir = path.join(emailDir, 'attachments');
  fs.mkdirSync(attachDir, { recursive: true });
  const manifestPath = path.join(emailDir, '.email-manifest.json');
  const manifest = loadManifest(manifestPath);
  const firstRun = manifest.baseline == null;
  const summary = { messages: 0, attachments: 0, skipped: 0, failed: 0, bytes: 0, triaged: 0, errors: [] };
  const triage = [];

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'outlook-'));
  try {
    await convert(pstPath, tmp);
    for (const eml of walkEmlFiles(tmp)) {
      try {
        const msg = normalizeMessage(parseEml(fs.readFileSync(eml)));
        if (manifest.messages[msg.messageId]) { summary.skipped++; continue; }
        const signals = classifySignals(msg, selfAddrs);
        const links = extractLinks(msg.text);
        const refs = [];
        for (const att of msg.attachments) {
          try {
            const name = await storeAttachment(attachDir, att);
            if (!refs.includes(name)) refs.push(name);
            summary.attachments++;
            summary.bytes += att.bytes.length;
          } catch (e) { summary.failed++; summary.errors.push(`attach ${att.filename}: ${e.message}`); }
        }
        const rel = messageRelPath(msg);
        const dest = path.join(emailDir, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        await writeReadOnly(dest, Buffer.from(renderMessageMarkdown(msg, refs, links, signals), 'utf-8'));
        manifest.messages[msg.messageId] = { date: msg.date, path: rel, attachments: refs };
        summary.messages++;
        if (shouldTriage(msg, signals, manifest, windowMs, now)) {
          triage.push({ messageId: msg.messageId, date: msg.date,
            from: decodeWord(msg.headers['from'] || ''), subject: msg.subject, path: rel, signals });
          summary.triaged++;
        }
      } catch (e) { summary.failed++; summary.errors.push(`${path.basename(eml)}: ${e.message}`); }
    }
    if (firstRun) manifest.baseline = new Date(now).toISOString();
    manifest.lastRun = new Date(now).toISOString();
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(emailDir, '.triage.json'),
      JSON.stringify({ generated: manifest.lastRun, firstRun, candidates: triage }, null, 2));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return summary;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run skills/outlook/scripts/sync.test.mjs`
Expected: PASS (all suites).

- [ ] **Step 5: Commit**

```bash
git add skills/outlook/scripts/sync.mjs skills/outlook/scripts/sync.test.mjs
git commit -m "feat(outlook): syncOutlook orchestration with injected converter"
```

---

## Task 9: `main()` entrypoint + run guard

**Files:**
- Modify: `skills/outlook/scripts/sync.mjs`

- [ ] **Step 1: Add `main()` and the direct-execution guard**

No new unit test (this is the I/O shell; logic is covered by `syncOutlook`). Append:

```js
// append to skills/outlook/scripts/sync.mjs
async function ensureReadpst() {
  try { await execFileP('readpst', ['-V']); }
  catch { console.error('readpst not found — install libpst (e.g. sudo apt install libpst).'); process.exit(1); }
}

async function main() {
  const hubDir = resolveHubDir(process.argv[2]);
  const pstPath = process.env.OUTLOOK_PST_PATH || newestPst(hubDir);
  if (!pstPath) { console.error('No .pst found in hub (set OUTLOOK_PST_PATH).'); process.exit(1); }
  await ensureReadpst();
  const selfAddrs = (process.env.OUTLOOK_SELF || deriveSelf(pstPath))
    .split(',').map((s) => s.trim()).filter(Boolean);
  console.error(`outlook sync → ${path.join(hubDir, 'email')} (pst: ${path.basename(pstPath)})`);
  const s = await syncOutlook({ hubDir, pstPath, selfAddrs });
  console.log(`Outlook: ${s.messages} new messages, ${s.attachments} attachments, ${s.skipped} unchanged, ${s.failed} failed · ${(s.bytes / 1e6).toFixed(1)} MB · ${s.triaged} triage candidates`);
  for (const e of s.errors.slice(0, 10)) console.error(`  ✗ ${e}`);
  if (s.messages === 0 && s.skipped === 0 && s.failed > 0) process.exit(1);
}

function realPath(p) { try { return fs.realpathSync(p); } catch { return path.resolve(p); } }
if (process.argv[1] && realPath(process.argv[1]) === realPath(fileURLToPath(import.meta.url))) {
  main();
}
```

- [ ] **Step 2: Verify the module still imports and tests pass (guard must not run on import)**

Run: `npx vitest run skills/outlook/scripts/`
Expected: PASS — all `mime.test.mjs` + `sync.test.mjs` suites green; no `main()` side effects during tests.

- [ ] **Step 3: Smoke-check the guard prints a clean error with no pst**

Run: `node skills/outlook/scripts/sync.mjs /tmp 2>&1 | head -1`
Expected: `No .pst found in hub (set OUTLOOK_PST_PATH).` (exit 1).

- [ ] **Step 4: Commit**

```bash
git add skills/outlook/scripts/sync.mjs
git commit -m "feat(outlook): main() entrypoint, readpst check, run guard"
```

---

## Task 10: `SKILL.md` (frontmatter + agent curation)

**Files:**
- Create: `skills/outlook/SKILL.md`

- [ ] **Step 1: Write `SKILL.md`**

```markdown
---
name: outlook
description: Ingest the daily NUS Outlook .pst export into a read-only email/ mirror and surface important mail into index.md. Use when the operator asks to sync, check, refresh, or pull their NUS email/inbox.
---

# Outlook email ingest

Ingest the operator's NUS mailbox (a daily full `.pst` export at the hub root)
into `<hub>/email/` and surface what matters into `index.md`.

## 1. Run the ingester

```bash
node ${CLAUDE_SKILL_DIR}/scripts/sync.mjs
```

- Needs `readpst` (libpst) on `PATH` and a `.pst` in the hub root
  (auto-detected; override with `OUTLOOK_PST_PATH`). Self address is derived
  from the `.pst` filename; override with `OUTLOOK_SELF` (comma-separated).
- Writes read-only message notes to `email/<year>/`, hash-deduped attachments to
  `email/attachments/`, dedups by `Message-ID` via `email/.email-manifest.json`,
  and emits `email/.triage.json`. First run also archives the whole backlog
  silently and triages the last 40 days.
- Report the printed summary line to the operator.

## 2. Curate the index

Read `<hub>/email/.triage.json`. Each candidate is mail the script judged
*possibly* important (bulk/newsletter mail is already filtered out). **You make
the final call.** For the ones that genuinely need the operator's attention
(deadlines, action items, someone waiting on a reply, meetings):

- Update an `## Inbox` section in `<hub>/index.md` (create it if missing), each
  line: `[subject](email/<year>/<file>.md) — short hook (who / what / by when)`.
- Collapse a thread to a single line; dedup against entries already there.
- Skip anything routine or purely informational. Leave `wiki/*.md` untouched.

Keep it tight — the index is a curated surface, not an inbox dump.
```

- [ ] **Step 2: Verify frontmatter parses (name + description present, single-line description)**

Run: `head -4 skills/outlook/SKILL.md`
Expected: shows `name: outlook` and a one-line `description:`.

- [ ] **Step 3: Commit**

```bash
git add skills/outlook/SKILL.md
git commit -m "feat(outlook): SKILL.md with ingest + index-curation instructions"
```

---

## Task 11: README + `work` alias docs

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add the `### outlook` subsection after the `### canvas` one**

Find the end of the `### canvas` subsection in `README.md` and insert:

```markdown
### outlook

Ingests the daily NUS Outlook `.pst` export (a full-mailbox snapshot at the hub
root) into a read-only `email/` mirror: year-bucketed message notes +
hash-deduped attachments under `email/attachments/`. Dedups by `Message-ID` via
`email/.email-manifest.json`, so old threads are stored once. Emits
`email/.triage.json`; when you run `/outlook`, Claude reads it and curates an
`## Inbox` section in `index.md` (bulk/newsletter mail is filtered out first).

- Needs `readpst` (libpst: `sudo apt install libpst`) and a `.pst` in the hub
  root (override with `OUTLOOK_PST_PATH`; self address via `OUTLOOK_SELF`).
- First run silently archives the whole backlog and triages the last 40 days;
  later runs triage only new mail.
- Invoke with `/outlook` or "check my email".
```

- [ ] **Step 2: Document the `work` alias as the hub entry point**

Find the section of `README.md` that explains opening the hub (near the top, "Run `claude` inside your OneDrive"). Add a fenced note right after it:

```markdown
In practice, open the hub with the `work` alias (in `~/.bashrc`):

```bash
alias work='(cd "/mnt/c/Users/<you>/OneDrive - National University of Singapore" && claude --remote-control)'
```

Typing `work` drops you into the hub with Remote Control on, where `/canvas`,
`/outlook`, and the other skills are available.
```

- [ ] **Step 3: Verify the additions render (no broken fences)**

Run: `grep -n "### outlook\|alias work" README.md`
Expected: both lines present.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(readme): document outlook skill + work alias entry point"
```

---

## Task 12: Full suite green + live verification against the real `.pst`

**Files:** none (verification only)

- [ ] **Step 1: Run the whole project test suite**

Run: `npm test`
Expected: PASS — all `skills/**/*.test.mjs` (canvas + outlook) green. Report the actual summary line.

- [ ] **Step 2: Dry-run conversion shape against a SMALL slice (no hub writes)**

The real `.pst` is ~4.2 GB; first confirm `readpst -e` output shape cheaply.

Run:
```bash
TMP=$(mktemp -d); timeout 600 readpst -e -q -o "$TMP" "/mnt/c/Users/jeonw/OneDrive - National University of Singapore/jeonwonje@u.nus.edu.pst" 2>&1 | tail -5; find "$TMP" -name '*.eml' | head -3; echo "eml count:"; find "$TMP" -name '*.eml' | wc -l
```
Expected: `.eml` files exist. Inspect one (`head -40` of a found file) to confirm headers + MIME look as the parser assumes. **Keep `$TMP` path noted; remove it after step 4** (`rm -rf "$TMP"`). If readpst writes non-`.eml` names, adjust `walkEmlFiles`/flags and re-run affected unit tests.

- [ ] **Step 3: Real run into a throwaway hub (not OneDrive)**

```bash
HUBTEST=$(mktemp -d); touch "$HUBTEST/CLAUDE.md"
OUTLOOK_PST_PATH="/mnt/c/Users/jeonw/OneDrive - National University of Singapore/jeonwonje@u.nus.edu.pst" \
  node skills/outlook/scripts/sync.mjs "$HUBTEST"
echo "--- triage candidates ---"; node -e "const t=require('$HUBTEST/email/.triage.json');console.log(t.candidates.length, t.firstRun)"
echo "--- sample message ---"; find "$HUBTEST/email/2026" -name '*.md' | head -1 | xargs head -20
echo "--- attachment dedup: files vs manifest refs ---"; ls "$HUBTEST/email/attachments" | wc -l
```
Expected: a summary line (N messages, attachments, triage count); message `.md` files have valid frontmatter; `.triage.json` excludes bulk mail; attachments present and deduped. Sanity-check a handful of triaged subjects are genuinely important and obvious newsletters are absent.

- [ ] **Step 4: Clean up throwaway dirs**

```bash
rm -rf "$HUBTEST" "$TMP"
```
Expected: no 4 GB scratch left behind. (The skill itself already cleans its own temp dir.)

- [ ] **Step 5: Final commit (if any heuristics/flags were tuned in steps 2-3)**

```bash
git add -A skills/outlook
git commit -m "fix(outlook): tune parsing/heuristics from live .pst verification"
```

(If nothing changed, skip. Do **not** commit any throwaway hub/temp output.)

---

## Self-Review (completed during planning)

- **Spec coverage:** readpst boundary (T8/T9), `.eml` parse + MIME (T2/T3), `email/` year-bucket store + read-only (T5/T6/T8), hash-dedup attachments (T6), Message-ID dedup (T6/T8), 40-day first-run + lastRun incremental (T6/T8), deterministic signals + bulk pre-filter (T4), `.triage.json` (T8), agent curates `index.md` (T10 SKILL.md), error handling (T9), README + `work` alias (T11), live verification (T12). All spec sections mapped.
- **Placeholder scan:** none — every code step is complete and runnable.
- **Type consistency:** message object shape `{ headers, messageId, date, subject, text, attachments:[{filename,bytes,contentType}] }` is produced by `normalizeMessage` and consumed identically by `classifySignals`/`messageRelPath`/`renderMessageMarkdown`/`syncOutlook`. Manifest shape `{ baseline, lastRun, messages }` consistent across `loadManifest`/`shouldTriage`/`syncOutlook`. Signal keys consistent T4↔T8.
- **Ordering note:** Task 1's `sync.mjs` imports `./mime.mjs`, created in Task 2 — execute Tasks in order; the broad `sync.test.mjs` suite is only fully runnable from Task 2 onward.
```
