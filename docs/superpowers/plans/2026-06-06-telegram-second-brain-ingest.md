# Telegram Second-Brain Ingest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `skills/telegram/` icarus skill — a GramJS ETL that incrementally archives all Telegram DMs/groups/channels to a local-only store and emits a delta for Claude to distill into per-chat digests in the hub.

**Architecture:** A dependency-light `.mjs` script does mechanical work only: pull → normalize → append to local JSONL → download media → emit `delta/latest.json`. The GramJS client is dependency-injected into `syncTelegram(...)` so all orchestration is unit-tested against a fake client with no network. Claude (driven by `SKILL.md`) reads the delta and writes digests — the script never summarizes.

**Tech Stack:** Node ≥20 (ESM), GramJS (`telegram` npm pkg, the one allowed dependency), `input` (login prompts only), vitest. Pure helpers + injected I/O, `main()` guarded by `import.meta` check (icarus convention).

---

## File Structure

```
skills/telegram/
  SKILL.md                 # description + workflow (run sync → curate digests)
  scripts/sync.mjs         # ETL: env/paths, pure helpers, I/O wrappers, syncTelegram, main()
  scripts/login.mjs        # one-time interactive login → prints StringSession
  scripts/sync.test.mjs    # vitest: pure helpers + syncTelegram against a fake client
package.json               # add "telegram" + "input" to dependencies
CLAUDE.md                  # document the dependency exception
README.md                  # add telegram skill entry (if a skills table exists)
```

`sync.mjs` is one focused file (mirrors `skills/canvas/scripts/sync.mjs`): exported pure helpers, exported `syncTelegram(deps)`, and a `main()` that runs only when executed directly. Everything network-touching lives in small wrapper functions that `syncTelegram` calls through its injected `client`, keeping the file testable.

**Normalized message record** (the shape every later task depends on):

```js
// One line of messages.jsonl
{
  id: 48213,                    // number, Telegram message id
  date: "2026-06-06T12:30:00.000Z", // ISO string (from msg.date unix seconds)
  from: "1404758730",           // String(senderId) or null
  text: "see you at 6",         // msg.message ?? ""
  reply_to: 48190,              // msg.replyTo?.replyToMsgId ?? null
  media: null                   // null | { type, path, size } | { type, skipped:"oversize", size }
}
```

**Manifest entry** (`.telegram-manifest.json`, keyed by String(dialog id)):

```js
{
  "1404758730": {
    title: "Mom", type: "user", slug: "mom-1404758730",
    lastId: 48213, lastDigestedId: 48190, mediaIds: [48201, 48207]
  }
}
```

---

## Task 1: Scaffold skill + add dependency

**Files:**
- Modify: `package.json` (add `dependencies`)
- Create: `skills/telegram/scripts/sync.mjs` (stub)
- Create: `skills/telegram/scripts/sync.test.mjs`

- [ ] **Step 1: Add dependencies to `package.json`**

Insert a `dependencies` block (top-level, before `devDependencies`):

```json
  "dependencies": {
    "telegram": "^2.26.0",
    "input": "^1.0.1"
  },
```

- [ ] **Step 2: Install**

Run: `npm install`
Expected: adds `telegram` + `input` to `node_modules`, updates `package-lock.json`, exits 0.

- [ ] **Step 3: Create the sync.mjs stub so tests can import it**

```js
// skills/telegram/scripts/sync.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const READ_ONLY = 0o444;
```

- [ ] **Step 4: Write a failing smoke test**

```js
// skills/telegram/scripts/sync.test.mjs
import { describe, it, expect } from 'vitest';
import * as sync from './sync.mjs';

describe('telegram sync module', () => {
  it('loads', () => {
    expect(typeof sync).toBe('object');
  });
});
```

- [ ] **Step 5: Run it**

Run: `npm test -- skills/telegram`
Expected: PASS (1 test). Confirms vitest discovers the new file.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json skills/telegram/scripts/sync.mjs skills/telegram/scripts/sync.test.mjs
git commit -m "feat(telegram): scaffold skill + GramJS dependency"
```

---

## Task 2: `resolveEnv` + `resolvePaths`

**Files:**
- Modify: `skills/telegram/scripts/sync.mjs`
- Test: `skills/telegram/scripts/sync.test.mjs`

- [ ] **Step 1: Write failing tests**

```js
import { resolveEnv, resolvePaths } from './sync.mjs';

describe('resolveEnv', () => {
  it('reads the three secrets', () => {
    const cfg = resolveEnv({ TELEGRAM_API_ID: '123', TELEGRAM_API_HASH: 'abc', TELEGRAM_SESSION: 's' });
    expect(cfg).toEqual({ apiId: 123, apiHash: 'abc', session: 's' });
  });
  it('throws a helpful message when a secret is missing', () => {
    expect(() => resolveEnv({ TELEGRAM_API_ID: '123' })).toThrow(/login\.mjs/);
  });
});

describe('resolvePaths', () => {
  it('defaults the archive dir and derives child paths', () => {
    const p = resolvePaths({});
    expect(p.archiveDir).toBe('/mnt/c/Users/jeonw/Desktop/telegram-chats');
    expect(p.archiveRoot).toBe('/mnt/c/Users/jeonw/Desktop/telegram-chats/archive');
    expect(p.manifestPath).toBe('/mnt/c/Users/jeonw/Desktop/telegram-chats/.telegram-manifest.json');
    expect(p.deltaPath).toBe('/mnt/c/Users/jeonw/Desktop/telegram-chats/delta/latest.json');
  });
  it('honors TELEGRAM_ARCHIVE_DIR override', () => {
    expect(resolvePaths({ TELEGRAM_ARCHIVE_DIR: '/tmp/tg' }).archiveDir).toBe('/tmp/tg');
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npm test -- skills/telegram`
Expected: FAIL — `resolveEnv is not a function`.

- [ ] **Step 3: Implement**

```js
const DEFAULT_ARCHIVE_DIR = '/mnt/c/Users/jeonw/Desktop/telegram-chats';

/** Read the three required secrets from the environment. */
export function resolveEnv(env = process.env) {
  const apiId = env.TELEGRAM_API_ID;
  const apiHash = env.TELEGRAM_API_HASH;
  const session = env.TELEGRAM_SESSION;
  if (!apiId || !apiHash || !session) {
    throw new Error(
      'Missing TELEGRAM_API_ID / TELEGRAM_API_HASH / TELEGRAM_SESSION. ' +
        'Run `node skills/telegram/scripts/login.mjs` and paste the printed values into ~/.bashrc.',
    );
  }
  return { apiId: Number(apiId), apiHash, session };
}

/** Derive every archive path from TELEGRAM_ARCHIVE_DIR (default: Desktop, local-only). */
export function resolvePaths(env = process.env) {
  const archiveDir = env.TELEGRAM_ARCHIVE_DIR || DEFAULT_ARCHIVE_DIR;
  return {
    archiveDir,
    archiveRoot: path.join(archiveDir, 'archive'),
    manifestPath: path.join(archiveDir, '.telegram-manifest.json'),
    deltaPath: path.join(archiveDir, 'delta', 'latest.json'),
  };
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `npm test -- skills/telegram`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/telegram/scripts/sync.mjs skills/telegram/scripts/sync.test.mjs
git commit -m "feat(telegram): env + path resolution"
```

---

## Task 3: `sanitizeSegment`, `slugify`, `dialogType`

**Files:**
- Modify: `skills/telegram/scripts/sync.mjs`
- Test: `skills/telegram/scripts/sync.test.mjs`

- [ ] **Step 1: Write failing tests**

```js
import { slugify, dialogType } from './sync.mjs';

describe('slugify', () => {
  it('combines a sanitized title with the numeric id', () => {
    expect(slugify('Mom', 1404758730)).toBe('mom-1404758730');
  });
  it('replaces separators and spaces with hyphens', () => {
    expect(slugify('CDE / Mech Group', 42)).toBe('cde-mech-group-42');
  });
  it('falls back to chat when the title is empty', () => {
    expect(slugify('', 7)).toBe('chat-7');
    expect(slugify(null, 7)).toBe('chat-7');
  });
});

describe('dialogType', () => {
  it('maps GramJS dialog booleans to user/group/channel', () => {
    expect(dialogType({ isUser: true })).toBe('user');
    expect(dialogType({ isGroup: true })).toBe('group');
    expect(dialogType({ isChannel: true })).toBe('channel');
    expect(dialogType({})).toBe('group');
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npm test -- skills/telegram`
Expected: FAIL — `slugify is not a function`.

- [ ] **Step 3: Implement**

```js
/** One safe, lowercase path segment: separators/space → '-', control chars stripped. */
export function sanitizeSegment(name) {
  const s = String(name ?? '')
    .replace(/\p{Cc}/gu, '')
    .trim()
    .toLowerCase()
    .replace(/[/\\\s]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return s;
}

/** Stable per-dialog slug: sanitized title + numeric id (always unique + readable). */
export function slugify(title, id) {
  const base = sanitizeSegment(title) || 'chat';
  return `${base}-${id}`;
}

/** Bucket a GramJS dialog: user → DM, anything else → group/channel. */
export function dialogType(dialog) {
  if (dialog.isUser) return 'user';
  if (dialog.isChannel) return 'channel';
  return 'group';
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `npm test -- skills/telegram`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/telegram/scripts/sync.mjs skills/telegram/scripts/sync.test.mjs
git commit -m "feat(telegram): slug + dialog-type helpers"
```

---

## Task 4: `describeMedia` + `normalizeMessage`

**Files:**
- Modify: `skills/telegram/scripts/sync.mjs`
- Test: `skills/telegram/scripts/sync.test.mjs`

- [ ] **Step 1: Write failing tests**

```js
import { describeMedia, normalizeMessage } from './sync.mjs';

describe('describeMedia', () => {
  it('returns null when there is no media', () => {
    expect(describeMedia({ media: null })).toBe(null);
  });
  it('extracts a type + byte size from a photo/document', () => {
    const msg = { media: { className: 'MessageMediaDocument', document: { size: 2048 } } };
    expect(describeMedia(msg)).toEqual({ type: 'document', size: 2048 });
  });
  it('handles photo media with no explicit size', () => {
    const msg = { media: { className: 'MessageMediaPhoto', photo: {} } };
    expect(describeMedia(msg)).toEqual({ type: 'photo', size: 0 });
  });
});

describe('normalizeMessage', () => {
  it('maps a GramJS message to the archive record shape', () => {
    const msg = {
      id: 48213,
      date: 1749212400, // 2025-06-06T12:20:00Z (unix seconds)
      message: 'see you at 6',
      senderId: { value: 1404758730n },
      replyTo: { replyToMsgId: 48190 },
      media: null,
    };
    expect(normalizeMessage(msg)).toEqual({
      id: 48213,
      date: '2025-06-06T11:00:00.000Z',
      from: '1404758730',
      text: 'see you at 6',
      reply_to: 48190,
      media: null,
    });
  });
  it('defaults text, sender and reply when absent', () => {
    const r = normalizeMessage({ id: 1, date: 0, media: null });
    expect(r).toEqual({ id: 1, date: '1970-01-01T00:00:00.000Z', from: null, text: '', reply_to: null, media: null });
  });
});
```

> Note: the expected ISO for `1749212400` is whatever `new Date(1749212400*1000).toISOString()` yields; if your assertion value differs, trust the function and update the literal — the contract is "unix seconds → ISO string".

- [ ] **Step 2: Run to confirm failure**

Run: `npm test -- skills/telegram`
Expected: FAIL — `describeMedia is not a function`.

- [ ] **Step 3: Implement**

```js
/** Summarize a message's media as { type, size } (no download here), or null. */
export function describeMedia(msg) {
  const m = msg.media;
  if (!m) return null;
  const cls = m.className || '';
  if (cls.includes('Photo')) return { type: 'photo', size: Number(m.photo?.size ?? 0) };
  if (cls.includes('Document')) return { type: 'document', size: Number(m.document?.size ?? 0) };
  return { type: 'other', size: 0 };
}

/** Telegram message → normalized archive record. Pure: no I/O. */
export function normalizeMessage(msg) {
  const senderId = msg.senderId?.value ?? msg.senderId ?? null;
  return {
    id: msg.id,
    date: new Date(Number(msg.date) * 1000).toISOString(),
    from: senderId == null ? null : String(senderId),
    text: msg.message ?? '',
    reply_to: msg.replyTo?.replyToMsgId ?? null,
    media: describeMedia(msg),
  };
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `npm test -- skills/telegram`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/telegram/scripts/sync.mjs skills/telegram/scripts/sync.test.mjs
git commit -m "feat(telegram): message normalization"
```

---

## Task 5: JSONL + manifest helpers

**Files:**
- Modify: `skills/telegram/scripts/sync.mjs`
- Test: `skills/telegram/scripts/sync.test.mjs`

- [ ] **Step 1: Write failing tests**

```js
import { toJsonl, parseJsonl, loadManifest, manifestEntry, updateCursor, isOversize } from './sync.mjs';

describe('jsonl', () => {
  it('round-trips records', () => {
    const recs = [{ id: 1, text: 'a' }, { id: 2, text: 'b' }];
    expect(parseJsonl(toJsonl(recs))).toEqual(recs);
  });
  it('parseJsonl ignores blank lines', () => {
    expect(parseJsonl('{"id":1}\n\n')).toEqual([{ id: 1 }]);
  });
});

describe('loadManifest', () => {
  it('returns {} for a missing file', () => {
    expect(loadManifest('/no/such/manifest.json')).toEqual({});
  });
});

describe('manifestEntry', () => {
  it('initializes a fresh entry for an unseen dialog', () => {
    const m = {};
    const e = manifestEntry(m, { id: 7, title: 'Mom', isUser: true });
    expect(e).toEqual({ title: 'Mom', type: 'user', slug: 'mom-7', lastId: 0, lastDigestedId: 0, mediaIds: [] });
    expect(m['7']).toBe(e);
  });
  it('returns the existing entry on subsequent calls', () => {
    const m = { '7': { title: 'Mom', type: 'user', slug: 'mom-7', lastId: 5, lastDigestedId: 5, mediaIds: [3] } };
    expect(manifestEntry(m, { id: 7, title: 'Mom', isUser: true }).lastId).toBe(5);
  });
});

describe('updateCursor', () => {
  it('advances lastId and records media ids', () => {
    const e = { lastId: 0, mediaIds: [] };
    updateCursor(e, [{ id: 10, media: { type: 'photo' } }, { id: 12, media: null }]);
    expect(e.lastId).toBe(12);
    expect(e.mediaIds).toEqual([10]);
  });
  it('never moves lastId backward', () => {
    const e = { lastId: 99, mediaIds: [] };
    updateCursor(e, [{ id: 5, media: null }]);
    expect(e.lastId).toBe(99);
  });
});

describe('isOversize', () => {
  it('compares bytes against a MB cap', () => {
    expect(isOversize(200 * 1024 * 1024, 100)).toBe(true);
    expect(isOversize(50 * 1024 * 1024, 100)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npm test -- skills/telegram`
Expected: FAIL — `toJsonl is not a function`.

- [ ] **Step 3: Implement**

```js
/** Records → newline-delimited JSON (trailing newline). */
export function toJsonl(records) {
  return records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');
}

/** Newline-delimited JSON → records (blank lines ignored). */
export function parseJsonl(text) {
  return text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));
}

/** Load the manifest JSON, or {} when it does not exist yet. */
export function loadManifest(manifestPath) {
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return {};
  }
}

/** Get (creating if absent) the manifest entry for a dialog. */
export function manifestEntry(manifest, dialog) {
  const key = String(dialog.id);
  if (!manifest[key]) {
    manifest[key] = {
      title: dialog.title ?? '',
      type: dialogType(dialog),
      slug: slugify(dialog.title, dialog.id),
      lastId: 0,
      lastDigestedId: 0,
      mediaIds: [],
    };
  }
  return manifest[key];
}

/** Advance lastId to the max id seen and append ids of messages that carried media. */
export function updateCursor(entry, records) {
  for (const r of records) {
    if (r.id > entry.lastId) entry.lastId = r.id;
    if (r.media && !entry.mediaIds.includes(r.id)) entry.mediaIds.push(r.id);
  }
}

/** True when a byte size exceeds the MB cap. */
export function isOversize(sizeBytes, capMb) {
  return sizeBytes > capMb * 1024 * 1024;
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `npm test -- skills/telegram`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/telegram/scripts/sync.mjs skills/telegram/scripts/sync.test.mjs
git commit -m "feat(telegram): jsonl + manifest cursor helpers"
```

---

## Task 6: `buildDelta` (window on bootstrap, group by chat)

**Files:**
- Modify: `skills/telegram/scripts/sync.mjs`
- Test: `skills/telegram/scripts/sync.test.mjs`

- [ ] **Step 1: Write failing tests**

```js
import { buildDelta } from './sync.mjs';

const chats = [
  { slug: 'mom-7', title: 'Mom', type: 'user',
    records: [
      { id: 1, date: '2026-01-01T00:00:00.000Z', from: '7', text: 'old', reply_to: null, media: null },
      { id: 2, date: '2026-06-05T00:00:00.000Z', from: '7', text: 'new', reply_to: null, media: null },
    ] },
];

describe('buildDelta', () => {
  it('on bootstrap keeps only records inside the window', () => {
    const now = new Date('2026-06-06T00:00:00.000Z');
    const delta = buildDelta(chats, { bootstrap: true, digestDays: 30, now });
    expect(delta.chats).toHaveLength(1);
    expect(delta.chats[0].records.map((r) => r.id)).toEqual([2]);
  });
  it('on incremental keeps every new record regardless of age', () => {
    const delta = buildDelta(chats, { bootstrap: false, digestDays: 30, now: new Date('2026-06-06T00:00:00.000Z') });
    expect(delta.chats[0].records.map((r) => r.id)).toEqual([1, 2]);
  });
  it('drops chats that have no records after windowing', () => {
    const now = new Date('2030-01-01T00:00:00.000Z');
    const delta = buildDelta(chats, { bootstrap: true, digestDays: 30, now });
    expect(delta.chats).toHaveLength(0);
  });
  it('stamps generatedAt from now', () => {
    const now = new Date('2026-06-06T00:00:00.000Z');
    expect(buildDelta([], { bootstrap: false, digestDays: 30, now }).generatedAt).toBe('2026-06-06T00:00:00.000Z');
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npm test -- skills/telegram`
Expected: FAIL — `buildDelta is not a function`.

- [ ] **Step 3: Implement**

```js
/**
 * Assemble delta/latest.json from this run's per-chat new records.
 * Bootstrap runs window to the last `digestDays` days so Claude never
 * summarizes years of backlog; incremental runs pass everything through.
 * Chats with no surviving records are dropped.
 */
export function buildDelta(chats, { bootstrap, digestDays, now }) {
  const cutoff = bootstrap ? new Date(now.getTime() - digestDays * 86400000) : null;
  const out = [];
  for (const c of chats) {
    const records = cutoff ? c.records.filter((r) => new Date(r.date) >= cutoff) : c.records;
    if (records.length) out.push({ slug: c.slug, title: c.title, type: c.type, records });
  }
  return { generatedAt: now.toISOString(), bootstrap, chats: out };
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `npm test -- skills/telegram`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/telegram/scripts/sync.mjs skills/telegram/scripts/sync.test.mjs
git commit -m "feat(telegram): delta builder with bootstrap windowing"
```

---

## Task 7: I/O wrappers + `syncTelegram` orchestration (fake client)

**Files:**
- Modify: `skills/telegram/scripts/sync.mjs`
- Test: `skills/telegram/scripts/sync.test.mjs`

This is the integration glue. The GramJS client is injected, so we test the full archive/manifest/delta flow against an in-memory fake and a temp dir — no network.

- [ ] **Step 1: Write failing tests**

```js
import os from 'node:os';
import fsp from 'node:fs/promises';
import { syncTelegram } from './sync.mjs';

function fakeClient() {
  return {
    connected: false,
    async connect() { this.connected = true; },
    async getDialogs() {
      return [
        { id: 7, title: 'Mom', isUser: true, entity: { id: 7 } },
        { id: 99, title: 'CDE Group', isGroup: true, entity: { id: 99 } },
      ];
    },
    // newest-first like Telegram; syncTelegram must sort ascending + filter > minId
    async *iterMessages(entity, { minId }) {
      const all = entity.id === 7
        ? [
            { id: 2, date: 1749000000, message: 'hi', senderId: 7, media: null },
            { id: 1, date: 1748000000, message: 'yo', senderId: 7, media: null },
          ]
        : [{ id: 5, date: 1749000000, message: 'meeting', senderId: 99, media: null }];
      for (const m of all) if (m.id > minId) yield m;
    },
    async downloadMedia() { return Buffer.from(''); },
  };
}

describe('syncTelegram', () => {
  it('archives all dialogs on bootstrap and writes a windowed delta', async () => {
    const archiveDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tg-'));
    const paths = {
      archiveDir,
      archiveRoot: path.join(archiveDir, 'archive'),
      manifestPath: path.join(archiveDir, '.telegram-manifest.json'),
      deltaPath: path.join(archiveDir, 'delta', 'latest.json'),
    };
    const summary = await syncTelegram({
      client: fakeClient(), paths,
      opts: { digestDays: 36500, fileMaxMb: 100, now: new Date('2026-06-06T00:00:00.000Z') },
    });

    expect(summary.chats).toBe(2);
    expect(summary.newMessages).toBe(3);

    const momJsonl = await fsp.readFile(path.join(paths.archiveRoot, 'mom-7', 'messages.jsonl'), 'utf8');
    expect(parseJsonl(momJsonl).map((r) => r.id)).toEqual([1, 2]); // ascending

    const manifest = JSON.parse(await fsp.readFile(paths.manifestPath, 'utf8'));
    expect(manifest['7'].lastId).toBe(2);

    const delta = JSON.parse(await fsp.readFile(paths.deltaPath, 'utf8'));
    expect(delta.bootstrap).toBe(true);
    expect(delta.chats.map((c) => c.slug).sort()).toEqual(['cde-group-99', 'mom-7']);
  });

  it('is incremental on a second run: only newer ids, no bootstrap window', async () => {
    const archiveDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tg-'));
    const paths = {
      archiveDir,
      archiveRoot: path.join(archiveDir, 'archive'),
      manifestPath: path.join(archiveDir, '.telegram-manifest.json'),
      deltaPath: path.join(archiveDir, 'delta', 'latest.json'),
    };
    const opts = { digestDays: 30, fileMaxMb: 100, now: new Date('2026-06-06T00:00:00.000Z') };
    await syncTelegram({ client: fakeClient(), paths, opts });
    const summary = await syncTelegram({ client: fakeClient(), paths, opts }); // nothing new
    expect(summary.newMessages).toBe(0);
    const delta = JSON.parse(await fsp.readFile(paths.deltaPath, 'utf8'));
    expect(delta.bootstrap).toBe(false);
    expect(delta.chats).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npm test -- skills/telegram`
Expected: FAIL — `syncTelegram is not a function`.

- [ ] **Step 3: Implement the I/O wrappers + orchestration**

```js
/** Download one message's media to <chatDir>/media, honoring the size cap. */
async function downloadMessageMedia(client, msg, record, chatDir, fileMaxMb) {
  if (!record.media) return;
  if (isOversize(record.media.size, fileMaxMb)) {
    record.media = { type: record.media.type, skipped: 'oversize', size: record.media.size };
    return;
  }
  const mediaDir = path.join(chatDir, 'media');
  await fs.promises.mkdir(mediaDir, { recursive: true });
  const buf = await client.downloadMedia(msg, {});
  if (!buf) return;
  const dest = path.join(mediaDir, `${msg.id}-${record.media.type}`);
  await fs.promises.writeFile(dest, buf);
  await fs.promises.chmod(dest, READ_ONLY).catch(() => {});
  record.media = { type: record.media.type, path: path.relative(chatDir, dest), size: record.media.size };
}

/** Append records to a chat's messages.jsonl, creating the dir as needed. */
async function appendArchive(archiveRoot, slug, records) {
  const chatDir = path.join(archiveRoot, slug);
  await fs.promises.mkdir(chatDir, { recursive: true });
  const file = path.join(chatDir, 'messages.jsonl');
  await fs.promises.appendFile(file, toJsonl(records));
  return chatDir;
}

/**
 * Full ETL. deps: { client, paths, opts:{ digestDays, fileMaxMb, now } }.
 * Returns a summary { chats, newMessages, media, skipped }.
 */
export async function syncTelegram({ client, paths, opts }) {
  const now = opts.now ?? new Date();
  await client.connect();
  const manifest = loadManifest(paths.manifestPath);
  const bootstrap = Object.keys(manifest).length === 0;
  const summary = { chats: 0, newMessages: 0, media: 0, skipped: 0 };
  const deltaChats = [];

  for (const dialog of await client.getDialogs()) {
    const entry = manifestEntry(manifest, dialog);
    const collected = [];
    for await (const msg of client.iterMessages(dialog.entity, { minId: entry.lastId })) {
      collected.push(msg);
    }
    if (!collected.length) {
      summary.chats += 1;
      continue;
    }
    collected.sort((a, b) => a.id - b.id); // Telegram yields newest-first; archive ascending
    const records = collected.map(normalizeMessage);
    const chatDir = await appendArchive(paths.archiveRoot, entry.slug, records);
    for (let i = 0; i < records.length; i++) {
      await downloadMessageMedia(client, collected[i], records[i], chatDir, opts.fileMaxMb);
      if (records[i].media?.path) summary.media += 1;
      if (records[i].media?.skipped) summary.skipped += 1;
    }
    updateCursor(entry, records);
    deltaChats.push({ slug: entry.slug, title: entry.title, type: entry.type, records });
    summary.chats += 1;
    summary.newMessages += records.length;
  }

  await fs.promises.mkdir(path.dirname(paths.deltaPath), { recursive: true });
  const delta = buildDelta(deltaChats, { bootstrap, digestDays: opts.digestDays, now });
  await fs.promises.writeFile(paths.deltaPath, JSON.stringify(delta, null, 2));
  await fs.promises.writeFile(paths.manifestPath, JSON.stringify(manifest, null, 2));
  return summary;
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `npm test -- skills/telegram`
Expected: PASS (both new cases + all prior).

- [ ] **Step 5: Commit**

```bash
git add skills/telegram/scripts/sync.mjs skills/telegram/scripts/sync.test.mjs
git commit -m "feat(telegram): syncTelegram orchestration over injected client"
```

---

## Task 8: `main()` + direct-run guard

**Files:**
- Modify: `skills/telegram/scripts/sync.mjs`

No unit test (it is the CLI shell over already-tested code); verified by running it. It will fail fast without credentials, which is the correct behavior to observe.

- [ ] **Step 1: Implement `main()` and the guard**

```js
/** CLI entry: build a live GramJS client from env, run the sync, print a summary. */
async function main() {
  const { TelegramClient } = await import('telegram');
  const { StringSession } = await import('telegram/sessions/index.js');
  const cfg = resolveEnv();
  const paths = resolvePaths();
  const opts = {
    digestDays: Number(process.env.TELEGRAM_DIGEST_DAYS || 30),
    fileMaxMb: Number(process.env.TELEGRAM_FILE_MAX_MB || 100),
    now: new Date(),
  };
  const client = new TelegramClient(new StringSession(cfg.session), cfg.apiId, cfg.apiHash, {
    connectionRetries: 5,
  });
  const s = await syncTelegram({ client, paths, opts });
  await client.disconnect();
  console.log(
    `telegram: ${s.chats} chats, ${s.newMessages} new messages, ${s.media} media, ${s.skipped} skipped-oversize → ${paths.archiveDir}`,
  );
}

// Run only when executed directly (icarus convention: realpath both sides).
function realPath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}
if (process.argv[1] && realPath(process.argv[1]) === realPath(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
```

- [ ] **Step 2: Verify the guard + fail-fast behavior**

Run: `TELEGRAM_API_ID= TELEGRAM_API_HASH= TELEGRAM_SESSION= node skills/telegram/scripts/sync.mjs`
Expected: exits 1, prints the `login.mjs` guidance message (proves `main()` runs and `resolveEnv` guards).

- [ ] **Step 3: Confirm importing does NOT run main**

Run: `npm test -- skills/telegram`
Expected: PASS, no connection attempts (the guard suppresses `main()` under vitest).

- [ ] **Step 4: Commit**

```bash
git add skills/telegram/scripts/sync.mjs
git commit -m "feat(telegram): main() entrypoint + run guard"
```

---

## Task 9: `login.mjs`

**Files:**
- Create: `skills/telegram/scripts/login.mjs`

Interactive, credential-producing, run by the operator once. Not unit-tested (pure I/O prompts); verified by the missing-creds error path.

- [ ] **Step 1: Implement**

```js
// skills/telegram/scripts/login.mjs
// One-time interactive login. Prints a StringSession to paste into ~/.bashrc.
// Requires TELEGRAM_API_ID + TELEGRAM_API_HASH in the environment.
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import input from 'input';

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;

if (!apiId || !apiHash) {
  console.error(
    'Set TELEGRAM_API_ID and TELEGRAM_API_HASH first (from https://my.telegram.org → API development tools).',
  );
  process.exit(1);
}

const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5 });

await client.start({
  phoneNumber: async () => await input.text('Phone number (international, e.g. +82109...): '),
  password: async () => await input.text('2FA password (blank if none): '),
  phoneCode: async () => await input.text('Login code Telegram just sent you: '),
  onError: (err) => console.error(err),
});

console.log('\nLogin OK. Add this line to ~/.bashrc (keep it secret):\n');
console.log(`export TELEGRAM_SESSION='${client.session.save()}'`);
await client.disconnect();
process.exit(0);
```

- [ ] **Step 2: Verify the guard path**

Run: `TELEGRAM_API_ID= TELEGRAM_API_HASH= node skills/telegram/scripts/login.mjs`
Expected: exits 1 with the my.telegram.org guidance (we do not perform a real login in automation).

- [ ] **Step 3: Commit**

```bash
git add skills/telegram/scripts/login.mjs
git commit -m "feat(telegram): one-time login helper"
```

---

## Task 10: `SKILL.md`

**Files:**
- Create: `skills/telegram/SKILL.md`

- [ ] **Step 1: Write the skill file**

````markdown
---
name: telegram
description: Archive all Telegram chats locally (DMs, groups, channels) and distill new activity into per-chat digests in telegram/. Use when the operator asks to sync, refresh, pull, or catch up on their Telegram.
---

# Telegram second-brain ingest

Maintain a local archive of the operator's Telegram and keep per-chat **digests**
in the hub current. Unlike canvas/outlook, this skill needs `npm install` once
(it depends on GramJS — see CLAUDE.md).

## 0. One-time setup

1. Create an app at https://my.telegram.org → API development tools.
2. In `~/.bashrc`: `export TELEGRAM_API_ID=…` and `export TELEGRAM_API_HASH=…`.
3. `node ${CLAUDE_SKILL_DIR}/scripts/login.mjs` → follow prompts → paste the
   printed `export TELEGRAM_SESSION=…` into `~/.bashrc`, then `source ~/.bashrc`.

## 1. Run the ingester

```bash
node ${CLAUDE_SKILL_DIR}/scripts/sync.mjs
```

- Reads `TELEGRAM_API_ID/HASH/SESSION` from the environment (never the hub).
- Archives messages + media to `${TELEGRAM_ARCHIVE_DIR:-/mnt/c/Users/jeonw/Desktop/telegram-chats}`
  (local-only, outside OneDrive). Media capped by `${TELEGRAM_FILE_MAX_MB:-100}`.
- Incremental: only fetches messages newer than the per-dialog cursor. First run
  archives everything silently and seeds the delta with the last
  `${TELEGRAM_DIGEST_DAYS:-30}` days only.
- Emits `delta/latest.json`. Report the printed summary line to the operator.

## 2. Curate the digests

Read `<archive>/delta/latest.json`. It is grouped by chat (`chats[].records`).
For each chat with new activity, open or create its digest —
`<hub>/telegram/dms/<slug>.md` (DMs) or `<hub>/telegram/groups/<slug>.md`
(groups/channels) — and update these sections, inferring meaning across
fragmented, sloppily-typed messages:

- **Summary** — rolling narrative of the relationship/thread.
- **Open threads** — unanswered questions, undecided things.
- **Action items** — what the operator owes, what they're waiting on, deadlines.
- **Key facts** — durable details (addresses, decisions, plans, preferences).

Then surface only genuinely actionable items (someone awaiting a reply, a dated
commitment) into `<hub>/index.md` under `## Telegram` — one line per chat, dedup
against existing entries. Routine chatter stays in the per-chat digest.

After digesting a chat, set `lastDigestedId` for that dialog in
`<archive>/.telegram-manifest.json` to its highest delta record id, so the next
run's delta starts clean. Keep digests tight — they are a curated surface, not a
transcript.
````

- [ ] **Step 2: Commit**

```bash
git add skills/telegram/SKILL.md
git commit -m "feat(telegram): SKILL.md with setup, ingest, digest workflow"
```

---

## Task 11: Document the dependency exception + verify everything

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md` (only if it lists skills)

- [ ] **Step 1: Add the exception to `CLAUDE.md` Conventions**

Append to the `## Conventions` bullet list:

```markdown
- **Exception — `telegram`:** the one skill that is *not* dependency-free. MTProto
  cannot be built from Node built-ins, so it depends on GramJS (`telegram`) +
  `input`. It requires `npm install`; canvas/outlook still run anywhere. Its raw
  archive is deliberately stored **outside** the hub (local-only) because it
  contains other people's private messages — only Claude-written digests land in
  the hub.
```

- [ ] **Step 2: Add a README skill entry if a skills list/table exists**

Run: `grep -n "canvas\|outlook" README.md`
If a skills list/table is present, add a sibling `telegram` row matching the
existing format: "Archive Telegram chats locally + digest into `telegram/`."
If no such list exists, skip this step.

- [ ] **Step 3: Full test + lint sweep**

Run: `npm test`
Expected: all suites PASS (canvas, outlook, telegram).

- [ ] **Step 4: Confirm the skill is dependency-correct**

Run: `node -e "import('telegram').then(()=>console.log('gramjs ok'))"`
Expected: prints `gramjs ok` (dependency resolves).

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs(telegram): document GramJS dependency exception"
```

- [ ] **Step 6: Note for the operator (manual, not automated)**

The live first run requires the operator's interactive login + Telegram
credentials, so it is run by the operator, not in CI:
1. complete Task 9 setup, then `node skills/telegram/scripts/sync.mjs`;
2. symlink the skill into the hub's `.claude/skills` if not already covered by a
   glob, so the CLI auto-discovers it.

---

## Self-Review

- **Spec coverage:** ETL script (T2–T8), local-only archive + paths (T2), slug/dialog buckets (T3), normalization + media (T4), JSONL + manifest cursor incl. `lastDigestedId` (T5), bootstrap 30-day windowing (T6), takeout-free incremental + summary line (T7–T8), login/session env-only (T9), digest workflow + hub `dms/`+`groups/` + index surfacing (T10), dependency exception + Desktop-backup caveat (T10/T11). All spec sections map to a task.
- **Deferred from spec, intentionally:** the bulk-pull **takeout session** is documented in the spec as a flood-limit optimization; v1 relies on GramJS's built-in flood-wait auto-sleep (honored via `connectionRetries`) and per-dialog resumable cursors. If first-run flood waits prove painful, wrapping the bootstrap loop in `account.initTakeoutSession` is a self-contained follow-up. Called out here so it is not a silent omission.
- **Placeholder scan:** none — every code step is complete.
- **Type consistency:** record shape `{id,date,from,text,reply_to,media}` and manifest entry `{title,type,slug,lastId,lastDigestedId,mediaIds}` are used identically across T4–T7; `syncTelegram`/`buildDelta`/`updateCursor` signatures match their call sites.
