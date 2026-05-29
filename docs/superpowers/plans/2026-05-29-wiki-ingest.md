# Wiki Ingest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let icarus save Telegram attachments (and pasted URLs) as immutable sources under a Desktop-backed `raw/` tree, then auto-distill each into a wiki page that cites its source.

**Architecture:** `data/raw` is a symlink to a Windows-Desktop folder so files are browsable from Windows while the agent still cites them as `raw/<file>`. `telegram.ts` downloads attachments into `raw/`; `bootstrap.ts` surfaces freshly-dropped files (`<new_sources>`) and the topic-folder tree (`<raw_folders>`) each turn; the persona's new Ingest operation tells the `claude` CLI to read the source, file it under a chosen topic folder, and write a cited wiki page.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), grammY, Node `https`/`fs`, vitest. Spawns the `claude` CLI (no model layer changes).

**Spec:** `docs/superpowers/specs/2026-05-29-wiki-ingest-design.md`

**Conventions to follow:**
- ESM imports use `.js` specifiers even for `.ts` files.
- Tests live in `test/<name>.test.ts`, run with `npm test` (vitest). They `process.chdir()` into a tmp dir and `vi.resetModules()` so `config.ts` re-reads env per test.
- `config.ts` resolves env via `fromEnv()` which checks `process.env` first, then `.env` — so tests set `process.env.RAW_DIR` to steer paths.
- Verification gate before any "done" claim: `npm run typecheck` and `npm test` both green.

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `src/config.ts` | env + path constants | Modify: add `RAW_DIR`, `TELEGRAM_BOT_DOWNLOAD_LIMIT_BYTES`; register `RAW_DIR` key |
| `src/memory/scaffold.ts` | create `data/` skeleton | Modify: add `rawDir()` + symlink-or-fallback creation |
| `src/memory/bootstrap.ts` | per-turn prompt prefix | Modify: add `<new_sources>` + `<raw_folders>` |
| `src/telegram.ts` | Telegram I/O + gating | Modify: download attachments → `raw/`, oversized guard, fold file notes into message content |
| `data/CLAUDE.md` | agent persona | Modify: add Ingest operation + citation/filing rules |
| `test/scaffold.test.ts` | scaffold tests | Modify: symlink + fallback cases |
| `test/bootstrap.test.ts` | bootstrap tests | Modify: `<new_sources>` + `<raw_folders>` cases |
| `test/telegram.test.ts` | telegram pure-helper tests | Create |

`src/index.ts` needs **no change**: the agent prompt is `msg.content`, and `telegram.ts` already folds the file notes into `content`, so they reach the turn automatically.

---

## Task 1: config — RAW_DIR + download limit

**Files:**
- Modify: `src/config.ts`

- [ ] **Step 1: Add the env key and constants**

In `src/config.ts`, change the `readEnvFile` call to register `RAW_DIR`:

```ts
const envConfig = readEnvFile(['TELEGRAM_BOT_TOKEN', 'OPERATOR_USER_ID', 'RAW_DIR']);
```

Then add these exports just below the existing `DB_PATH` line:

```ts
// raw/ source tree. Symlinked from data/raw to this path (default: Windows
// Desktop so files are browsable from Windows). Override via RAW_DIR in .env.
export const RAW_DIR = fromEnv('RAW_DIR') || '/mnt/c/Users/jeonw/Desktop/icarus-raw';

// Telegram's cloud Bot API caps file downloads at 20 MB; larger files fail at
// getFile(), so we detect and warn instead of attempting the download.
export const TELEGRAM_BOT_DOWNLOAD_LIMIT_BYTES = 20 * 1024 * 1024;
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no output, exit 0).

- [ ] **Step 3: Commit**

```bash
git add src/config.ts
git commit -m "feat(config): add RAW_DIR and Telegram download-limit constants"
```

---

## Task 2: scaffold — rawDir() + Desktop symlink with local fallback

**Files:**
- Modify: `src/memory/scaffold.ts`
- Test: `test/scaffold.test.ts`

- [ ] **Step 1: Write the failing tests**

Append these two tests inside the `describe('ensureDataLayout', ...)` block in `test/scaffold.test.ts`:

```ts
  it('symlinks data/raw to RAW_DIR when its parent exists', async () => {
    const desktop = path.join(tmpRoot, 'desktop');
    fs.mkdirSync(desktop, { recursive: true });
    process.env.RAW_DIR = path.join(desktop, 'icarus-raw');
    const { ensureDataLayout, rawDir } = await import('../src/memory/scaffold.js');
    ensureDataLayout();
    const link = rawDir();
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(link)).toBe(fs.realpathSync(process.env.RAW_DIR));
    delete process.env.RAW_DIR;
  });

  it('falls back to a real local data/raw when the RAW_DIR parent is missing', async () => {
    process.env.RAW_DIR = path.join(tmpRoot, 'no-such-mount', 'deep', 'icarus-raw');
    const { ensureDataLayout, rawDir } = await import('../src/memory/scaffold.js');
    ensureDataLayout();
    const link = rawDir();
    const st = fs.lstatSync(link);
    expect(st.isSymbolicLink()).toBe(false);
    expect(st.isDirectory()).toBe(true);
    delete process.env.RAW_DIR;
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/scaffold.test.ts`
Expected: FAIL — `rawDir` is not exported from scaffold (import error / undefined).

- [ ] **Step 3: Implement rawDir() and the symlink logic**

In `src/memory/scaffold.ts`, update the config import to include `RAW_DIR`:

```ts
import { DATA_DIR, RAW_DIR } from '../config.js';
```

Add a `rawDir()` accessor next to the other path accessors (e.g. after `outboxDir()`):

```ts
export function rawDir(): string {
  return path.join(DATA_DIR, 'raw');
}
```

Add this helper above `ensureDataLayout()`:

```ts
/**
 * Ensure data/raw points at the source tree. Normal case: symlink data/raw to
 * RAW_DIR (a Windows-Desktop folder) so files are browsable from Windows while
 * the agent still cites them as raw/<file>. If RAW_DIR's parent doesn't exist
 * (e.g. running off-Windows with no /mnt/c), fall back to a real local
 * data/raw directory so the bot still runs. No-op if data/raw already exists.
 */
function ensureRawLink(): boolean {
  const link = rawDir();
  let existing: fs.Stats | null = null;
  try {
    existing = fs.lstatSync(link);
  } catch {
    existing = null;
  }
  if (existing) return false; // real dir or symlink already present — leave it

  const parent = path.dirname(RAW_DIR);
  if (fs.existsSync(parent)) {
    fs.mkdirSync(RAW_DIR, { recursive: true });
    fs.symlinkSync(RAW_DIR, link);
    logger.info({ link, target: RAW_DIR }, 'raw/ symlinked to source tree');
  } else {
    fs.mkdirSync(link, { recursive: true });
    logger.warn({ target: RAW_DIR, parent }, 'RAW_DIR parent missing; using local data/raw');
  }
  return true;
}
```

Then call it inside `ensureDataLayout()`, folding its result into `created`. Insert this immediately after the `for (const dir of [...])` loop:

```ts
  if (ensureRawLink()) created = true;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- test/scaffold.test.ts`
Expected: PASS (all scaffold tests, including the two new ones).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/memory/scaffold.ts test/scaffold.test.ts
git commit -m "feat(scaffold): symlink data/raw to Desktop source tree, local fallback"
```

---

## Task 3: bootstrap — `<new_sources>` and `<raw_folders>`

**Files:**
- Modify: `src/memory/bootstrap.ts`
- Test: `test/bootstrap.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `test/bootstrap.test.ts`. First extend the `setup()` helper to optionally seed raw files — replace the existing `setup` function with:

```ts
async function setup(opts: {
  index?: string;
  log?: string;
  skills?: Record<string, string>;
  rawFiles?: string[];        // paths relative to raw/, e.g. 'a.pdf' or 'receipts/b.pdf'
  oldRawFiles?: string[];     // same, but stamped older than log.md
}) {
  const { ensureDataLayout, dataDir, skillsDir, rawDir } = await import('../src/memory/scaffold.js');
  ensureDataLayout();
  if (opts.index !== undefined) fs.writeFileSync(path.join(dataDir(), 'index.md'), opts.index);
  if (opts.log !== undefined) fs.writeFileSync(path.join(dataDir(), 'log.md'), opts.log);
  if (opts.skills) {
    for (const [name, content] of Object.entries(opts.skills)) {
      fs.writeFileSync(path.join(skillsDir(), name), content);
    }
  }
  const logMtime = fs.statSync(path.join(dataDir(), 'log.md')).mtimeMs;
  for (const rel of opts.rawFiles ?? []) {
    const full = path.join(rawDir(), rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, 'x');
  }
  for (const rel of opts.oldRawFiles ?? []) {
    const full = path.join(rawDir(), rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, 'x');
    const old = (logMtime - 120_000) / 1000;
    fs.utimesSync(full, old, old);
  }
}
```

Then add a new describe block at the end of the file:

```ts
describe('buildBootstrapPrefix raw/ ingest blocks', () => {
  it('lists top-level files dropped since the last log entry in <new_sources>', async () => {
    await setup({
      index: '# Wiki index\nempty',
      log: '# Activity log\n\n2026-05-25 09:00 — turn.',
      rawFiles: ['invoice.pdf'],
    });
    const { buildBootstrapPrefix } = await import('../src/memory/bootstrap.js');
    const prefix = buildBootstrapPrefix();
    expect(prefix).toContain('<new_sources>');
    expect(prefix).toContain('raw/invoice.pdf');
  });

  it('excludes nested and old files from <new_sources>', async () => {
    await setup({
      index: '# Wiki index\nempty',
      log: '# Activity log\n\nturn.',
      rawFiles: ['receipts/nested.pdf'],   // nested → not top-level
      oldRawFiles: ['stale.pdf'],           // stamped older than log
    });
    const { buildBootstrapPrefix } = await import('../src/memory/bootstrap.js');
    const prefix = buildBootstrapPrefix();
    expect(prefix).not.toContain('raw/receipts/nested.pdf');
    expect(prefix).not.toContain('raw/stale.pdf');
  });

  it('renders existing topic folders in <raw_folders>', async () => {
    await setup({
      index: '# Wiki index\nempty',
      log: '# Activity log\n\nturn.',
      rawFiles: ['receipts/a.pdf', 'medical/b.pdf'],
    });
    const { buildBootstrapPrefix } = await import('../src/memory/bootstrap.js');
    const prefix = buildBootstrapPrefix();
    expect(prefix).toContain('<raw_folders>');
    expect(prefix).toContain('raw/receipts/');
    expect(prefix).toContain('raw/medical/');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/bootstrap.test.ts`
Expected: FAIL — `<new_sources>` / `<raw_folders>` blocks not emitted.

- [ ] **Step 3: Implement the two listers and wire them in**

In `src/memory/bootstrap.ts`, update imports to add `rawDir` and `logFile`:

```ts
import { indexFile, logFile, rawDir, skillsDir } from './scaffold.js';
```

Add these two functions above `buildBootstrapPrefix`:

```ts
/**
 * Top-level files under raw/ with mtime newer than log.md (minus a 60s skew
 * margin) — i.e. sources dropped since the last logged turn. Newly-arrived
 * files sit at the raw/ root; once the agent files them into a topic folder
 * they become nested and stop surfacing here.
 */
function listNewSources(): string[] {
  const dir = rawDir();
  if (!fs.existsSync(dir)) return [];
  const log = logFile();
  const logMtime = fs.existsSync(log) ? fs.statSync(log).mtimeMs : 0;
  const fresh: string[] = [];
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    try {
      const stat = fs.statSync(full);
      if (stat.isFile() && stat.mtimeMs > logMtime - 60_000) {
        fresh.push(`raw/${entry}`);
      }
    } catch {
      // Dangling symlink or transient fs error — skip.
    }
  }
  return fresh;
}

/**
 * 2-level directory listing under raw/ so the agent can file new sources into
 * an existing topic folder instead of inventing duplicates. Second-level
 * listing is capped per folder to keep the prefix cheap.
 */
function listRawTree(): string {
  const dir = rawDir();
  if (!fs.existsSync(dir)) return '';
  const lines: string[] = [];
  const top = fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() || e.isSymbolicLink())
    .map((e) => e.name)
    .filter((n) => !n.startsWith('.'))
    .sort();
  for (const name of top) {
    lines.push(`raw/${name}/`);
    const sub = path.join(dir, name);
    try {
      const children = fs.readdirSync(sub, { withFileTypes: true })
        .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith('.'))
        .map((e) => e.name)
        .sort();
      const shown = children.slice(0, 12);
      for (const c of shown) lines.push(`  raw/${name}/${c}/`);
      if (children.length > shown.length) {
        lines.push(`  ... ${children.length - shown.length} more`);
      }
    } catch {
      // Dangling or unreadable; skip.
    }
  }
  return lines.join('\n');
}
```

Then update `buildBootstrapPrefix` to compute and append the blocks. After the existing `const skills = listSkills();` line add:

```ts
  const rawTree = listRawTree();
  const newSources = listNewSources();
```

And after the existing `if (skills) parts.push(...)` line add:

```ts
  if (rawTree) parts.push(`<raw_folders>\n${rawTree}\n</raw_folders>`);
  if (newSources.length)
    parts.push(`<new_sources>\n${newSources.join('\n')}\n</new_sources>`);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- test/bootstrap.test.ts`
Expected: PASS (all bootstrap tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/memory/bootstrap.ts test/bootstrap.test.ts
git commit -m "feat(bootstrap): surface <new_sources> and <raw_folders> each turn"
```

---

## Task 4: telegram — download attachments, oversized guard, file notes

This task adds two pure, testable helpers (`detectOversizedAttachment`, `buildContentWithFileNotes`) plus the I/O glue (`downloadTelegramFile`, `extractFiles`). Only the pure helpers are unit-tested; the I/O glue is exercised manually (it needs the live Bot API).

**Files:**
- Modify: `src/telegram.ts`
- Test: `test/telegram.test.ts` (create)

- [ ] **Step 1: Write the failing tests**

Create `test/telegram.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
  buildContentWithFileNotes,
  detectOversizedAttachment,
  type DownloadedFile,
} from '../src/telegram.js';

const TWENTY_MB = 20 * 1024 * 1024;

describe('detectOversizedAttachment', () => {
  it('flags a document larger than the download cap', () => {
    const msg = { message_id: 1, document: { file_name: 'big.zip', file_size: TWENTY_MB + 1 } };
    expect(detectOversizedAttachment(msg)).toEqual({ name: 'big.zip', sizeBytes: TWENTY_MB + 1 });
  });

  it('returns null for a document under the cap', () => {
    const msg = { message_id: 1, document: { file_name: 'ok.pdf', file_size: 1024 } };
    expect(detectOversizedAttachment(msg)).toBeNull();
  });

  it('ignores photos (Telegram rescales them under the cap)', () => {
    const msg = { message_id: 1, photo: [{ file_id: 'p', file_size: TWENTY_MB + 1 }] };
    expect(detectOversizedAttachment(msg)).toBeNull();
  });

  it('returns null when there is no attachment', () => {
    expect(detectOversizedAttachment({ message_id: 1, text: 'hi' })).toBeNull();
  });
});

describe('buildContentWithFileNotes', () => {
  const files: DownloadedFile[] = [
    { localPath: '/data/raw/a.pdf', originalName: 'a.pdf', kind: 'document', sizeBytes: 10 },
  ];

  it('returns plain text when no files', () => {
    expect(buildContentWithFileNotes('hello', [])).toBe('hello');
  });

  it('prepends a saved-to note and keeps the caption', () => {
    const out = buildContentWithFileNotes('my invoice', files);
    expect(out).toContain('[document: a.pdf] saved to raw/a.pdf');
    expect(out).toContain('my invoice');
  });

  it('emits just the note when there is no text', () => {
    expect(buildContentWithFileNotes('', files)).toBe('[document: a.pdf] saved to raw/a.pdf');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/telegram.test.ts`
Expected: FAIL — the helpers / `DownloadedFile` type are not exported.

- [ ] **Step 3: Implement the helpers and download glue**

In `src/telegram.ts`, add Node imports at the top (above the grammY import):

```ts
import fs from 'fs';
import https from 'https';
import path from 'path';
```

Extend the config import to add the new constants:

```ts
import {
  OPERATOR_USER_ID,
  TELEGRAM_BOT_DOWNLOAD_LIMIT_BYTES,
  TELEGRAM_BOT_TOKEN,
} from './config.js';
```

Add these imports too:

```ts
import { rawDir } from './memory/scaffold.js';
import { sanitizeFileName } from './slug.js';
```

Add the exported `DownloadedFile` type next to `InboundMessage`:

```ts
export interface DownloadedFile {
  localPath: string;
  originalName: string;
  kind: 'document' | 'photo' | 'audio' | 'voice' | 'video';
  sizeBytes: number;
}
```

Add the pure helpers (place them after `parseCommand`). `detectOversizedAttachment` takes the loosely-typed `ctx.message` so it is trivially unit-testable:

```ts
/**
 * Loose shape of the fields we read off a Telegram message. grammY's own type
 * is far larger; we only touch these.
 */
interface RawMessage {
  message_id?: number;
  text?: string;
  caption?: string;
  document?: { file_id?: string; file_name?: string; file_size?: number };
  photo?: { file_id?: string; file_size?: number }[];
  audio?: { file_id?: string; file_name?: string; mime_type?: string; file_size?: number };
  voice?: { file_id?: string; file_size?: number };
  video?: { file_id?: string; file_name?: string; file_size?: number };
}

/**
 * Return the first attachment whose advertised size exceeds Telegram's 20 MB
 * bot-download cap, or null. Photos are excluded — Telegram rescales them.
 */
export function detectOversizedAttachment(
  m: RawMessage,
): { name: string; sizeBytes: number } | null {
  const candidates: { name: string; size?: number }[] = [];
  if (m.document) candidates.push({ name: m.document.file_name || `doc_${m.message_id}`, size: m.document.file_size });
  if (m.video) candidates.push({ name: m.video.file_name || `video_${m.message_id}.mp4`, size: m.video.file_size });
  if (m.audio) candidates.push({ name: m.audio.file_name || `audio_${m.message_id}`, size: m.audio.file_size });
  if (m.voice) candidates.push({ name: `voice_${m.message_id}.ogg`, size: m.voice.file_size });
  for (const c of candidates) {
    if (typeof c.size === 'number' && c.size > TELEGRAM_BOT_DOWNLOAD_LIMIT_BYTES) {
      return { name: c.name, sizeBytes: c.size };
    }
  }
  return null;
}

/** Build the agent prompt text from the caption plus one note per saved file. */
export function buildContentWithFileNotes(text: string, files: DownloadedFile[]): string {
  if (files.length === 0) return text;
  const lines = files.map(
    (f) => `[${f.kind}: ${f.originalName}] saved to raw/${path.basename(f.localPath)}`,
  );
  if (text) lines.push(text);
  return lines.join('\n');
}

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(1)} MB`;
}
```

Add the download + extraction glue (place after the helpers above):

```ts
async function downloadTelegramFile(
  api: Api,
  token: string,
  fileId: string,
  fileName: string,
): Promise<string | null> {
  try {
    const file = await api.getFile(fileId);
    if (!file.file_path) {
      logger.warn({ fileId }, 'getFile returned no file_path');
      return null;
    }
    const dir = rawDir();
    fs.mkdirSync(dir, { recursive: true });
    const safe = sanitizeFileName(fileName);
    let localPath = path.join(dir, safe);
    if (fs.existsSync(localPath)) {
      localPath = path.join(dir, `${Date.now()}_${safe}`);
    }
    const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
    await new Promise<void>((resolve, reject) => {
      const out = fs.createWriteStream(localPath);
      https
        .get(url, (res) => {
          if (res.statusCode !== 200) {
            out.close();
            try { fs.unlinkSync(localPath); } catch { /* ignore */ }
            reject(new Error(`HTTP ${res.statusCode} downloading file`));
            return;
          }
          res.pipe(out);
          out.on('finish', () => { out.close(); resolve(); });
          out.on('error', reject);
        })
        .on('error', reject);
    });
    return localPath;
  } catch (err) {
    logger.error({ fileId, fileName, err }, 'downloadTelegramFile failed');
    return null;
  }
}

async function extractFiles(ctx: Context): Promise<DownloadedFile[]> {
  const msg = ctx.message;
  if (!msg) return [];
  const out: DownloadedFile[] = [];
  const push = async (
    fileId: string,
    name: string,
    kind: DownloadedFile['kind'],
  ): Promise<void> => {
    const local = await downloadTelegramFile(ctx.api, TELEGRAM_BOT_TOKEN, fileId, name);
    if (local) out.push({ localPath: local, originalName: name, kind, sizeBytes: fs.statSync(local).size });
  };
  if (msg.document) {
    await push(msg.document.file_id, msg.document.file_name || `doc_${msg.document.file_id}`, 'document');
  }
  if (msg.photo && msg.photo.length > 0) {
    const best = msg.photo[msg.photo.length - 1]; // largest size
    await push(best.file_id, `photo_${msg.message_id}.jpg`, 'photo');
  }
  if (msg.audio) {
    const ext = msg.audio.mime_type?.includes('mp3') ? 'mp3' : 'audio';
    await push(msg.audio.file_id, msg.audio.file_name || `audio_${msg.audio.file_id}.${ext}`, 'audio');
  }
  if (msg.voice) {
    await push(msg.voice.file_id, `voice_${msg.message_id}.ogg`, 'voice');
  }
  if (msg.video) {
    await push(msg.video.file_id, msg.video.file_name || `video_${msg.message_id}.mp4`, 'video');
  }
  return out;
}
```

Now wire extraction into the operator path of `bot.on('message', ...)`. Find this block (after the `isAuthorized(ctx)` gate):

```ts
      const content = ctx.message?.text ?? ctx.message?.caption ?? '';
      insertMessage({
```

Replace the `const content = ...` line with the oversized guard + extraction:

```ts
      const oversized = detectOversizedAttachment((ctx.message ?? {}) as unknown as RawMessage);
      if (oversized) {
        await ctx.api.sendMessage(
          chatId,
          `[oversized: ${oversized.name} (${formatBytes(oversized.sizeBytes)}) not downloaded — ` +
            `exceeds Telegram's 20 MB bot-download cap]`,
        );
      }
      const files = oversized ? [] : await extractFiles(ctx);
      const text = ctx.message?.text ?? ctx.message?.caption ?? '';
      const content = buildContentWithFileNotes(text, files);
      insertMessage({
```

(The rest of the block — `insertMessage` and `handlers.onMessage` — is unchanged; both already use `content`.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- test/telegram.test.ts`
Expected: PASS (7 assertions across the two describe blocks).

- [ ] **Step 5: Full test suite + typecheck**

Run: `npm test`
Expected: PASS (all suites).

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/telegram.ts test/telegram.test.ts
git commit -m "feat(telegram): download attachments into raw/, guard oversized, note saved files"
```

---

## Task 5: persona — Ingest operation

**Files:**
- Modify: `data/CLAUDE.md`

No automated test — this is agent-facing prose. Verify by reading after the edit.

- [ ] **Step 1: Add the raw/ and outbox lines to the memory schema**

In `data/CLAUDE.md`, in the `## Memory schema` code fence, add a `raw/` entry above the `wiki/` line so the tree reads:

```
  raw/                          ← immutable source files (symlinked to your Desktop); cite, never edit
  wiki/                         ← your markdown notes
```

- [ ] **Step 2: Add the Ingest operation**

In the `## Operations` section, add this as the first bullet (above the existing **Query** bullet):

```markdown
- **Ingest** (when files appear in `<new_sources>` or you're given a URL). Do this proactively, the same turn:
  - **Read the source.** Your `Read` tool handles PDFs and images directly — use it. For opaque binaries (CAD/STEP/IGES/STL/DWG), gather what `Bash: file`/`stat`/`ls -la` reveal and write a `wiki/_meta/<file>.meta.md` sidecar noting what is inferred vs. known.
  - **File it.** Pick a fitting topic folder from `<raw_folders>` (e.g. `raw/receipts/`, `raw/medical/`, `raw/travel/`) or create a sensibly named new one, and **move** the file there. Never edit a source; never `rm -rf` inside `raw/`.
  - **Distill.** Write or update a small wiki page (one entity/concept) that **cites** its source: `raw/<topic>/<file>` for files, the URL for links. Update `index.md`. Append a `[ingest]` line to `log.md`.
  - **URLs.** When the operator pastes a link, fetch it with `WebFetch` and distill it the same way (citation = the URL). No browser is involved.
```

- [ ] **Step 3: Add the citation rule**

In the `## Rules` section, add this bullet after the existing `Keep index.md in sync…` line:

```markdown
- Every page distilled from a source must cite it (`raw/<topic>/<file>` or the URL). Sources under `raw/` are immutable — read and cite, don't modify.
```

- [ ] **Step 4: Verify**

Run: `cat data/CLAUDE.md`
Expected: the Memory schema shows `raw/`, Operations leads with **Ingest**, and Rules has the citation bullet. Confirm there are no leftover placeholders.

- [ ] **Step 5: Commit**

```bash
git add data/CLAUDE.md
git commit -m "docs(persona): add Ingest operation, raw/ sources, citation rule"
```

---

## Task 6: Final verification

- [ ] **Step 1: Full suite**

Run: `npm test`
Expected: PASS — all of `scaffold`, `bootstrap`, `telegram`, `slug`, `db`, `outbox`.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: PASS (clean `tsc` compile to `dist/`).

- [ ] **Step 4: Report**

Report actual command output for all three. If anything fails, fix before claiming done.

---

## Self-review notes

- **Spec coverage:** raw/ on Desktop (Task 2) ✓; attachment ingest (Task 4) ✓; `<new_sources>`/`<raw_folders>` (Task 3) ✓; bot-chosen topic folders (Task 5 persona + Task 3 `<raw_folders>`) ✓; cited-page distillation (Task 5) ✓; URL ingest via WebFetch (Task 5) ✓; oversized guard (Task 4) ✓; binary `_meta` fallback (Task 5) ✓; symlink mount fallback (Task 2) ✓.
- **Out of scope confirmed absent:** no opencode layer, no browser, no bulk-ingest CLI, no git-backup timer, no `pdftotext`/`tesseract`.
- **Type consistency:** `DownloadedFile` shape identical across telegram impl + test; `detectOversizedAttachment` takes `RawMessage` in both; `rawDir()` is the single source of the `data/raw` path used by scaffold, bootstrap, and telegram.
- **No index.ts change:** confirmed — file notes flow through `msg.content`, which `runTurn` already uses as the prompt.
