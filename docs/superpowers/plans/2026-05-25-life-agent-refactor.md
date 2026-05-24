# icarus Life-Agent Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse icarus's per-Telegram-topic architecture into a single-operator life agent: one shared wiki, one log, one Claude session, one DM gate (`OPERATOR_USER_ID`).

**Architecture:** Strip the `threadJid` / `data/threads/<id>/` layer everywhere. The bot listens for private DMs from one operator; every turn runs `claude` with `cwd=data/`. One row in the `sessions` table keyed `'life'`. One mutex slug `'life'`.

**Tech Stack:** TypeScript, Node 20+, grammY (Telegram), better-sqlite3, vitest. Spawns the local `claude` CLI per turn.

**Spec:** `docs/superpowers/specs/2026-05-25-life-agent-design.md`.

**Conventions for executor:**

- Run from `/home/jeon/icarus`.
- TDD where tests exist; for non-test-covered modules verification is the run command stated in the task.
- Some intermediate commits will fail `npm run typecheck` because downstream consumers haven't been updated yet. **Do not let that block progress** — the final task (`Task 11`) gates on a clean typecheck + test run.
- Commit after each task using the message shown in that task's Step "Commit".
- For destructive deletes, use `git rm` so the deletion is tracked.
- The harness blocks chained `git commit && git push` — run them as separate commands when committing.

---

## File Map

| File | Action | Responsibility (post-refactor) |
|---|---|---|
| `src/config.ts` | modify | `OPERATOR_USER_ID` + `TELEGRAM_BOT_TOKEN` + paths/timeouts. |
| `src/env.ts` | modify | Read `OPERATOR_USER_ID` from `.env`. |
| `src/db.ts` | modify | Messages table (jid-free) + single-row sessions table. |
| `src/agent-runner.ts` | modify | Argless logging tag; same streaming behavior. |
| `src/agent-types.ts` | unchanged | — |
| `src/memory/scaffold.ts` | modify | `ensureDataLayout()` creates wiki/, outbox/, skills/, seeds index.md/log.md. |
| `src/memory/bootstrap.ts` | modify | Argless `buildBootstrapPrefix()` reading from `data/`. |
| `src/memory/log.ts` | modify | Argless `appendLogEntry`/`readLogTail`, writing `data/log.md`. |
| `src/memory/outbox.ts` | modify | Argless `listOutbox`/`removeOutboxFile` against `data/outbox/`. |
| `src/memory/threads.ts` | DELETE | — |
| `src/admin-commands.ts` | modify | `/whoami`, `/ping`, `/help`. |
| `src/telegram.ts` | modify | DM-only gate by `OPERATOR_USER_ID`; `InboundMessage`; `sendText`/`sendFile`. |
| `src/index.ts` | modify | Single mutex `'life'`; argless calls; `onMessage`. |
| `src/mutex.ts` | unchanged | — |
| `src/slug.ts` | unchanged | — |
| `src/logger.ts` | unchanged | — |
| `scripts/weekly-prune.ts` | modify | Shares the `'life'` session; single-wiki prompt. |
| `data/CLAUDE.md` | rewrite | Life-agent persona; cwd is `data/`. |
| `data/skills/prune-wiki.md` | rewrite | Single-wiki procedure (no cross-topic mode). |
| `CLAUDE.md` (root) | rewrite | Project guide for the new architecture. |
| `README.md` | rewrite | User-facing pitch for life-agent shape. |
| `.gitignore` | modify | Replace `data/threads/` with new gitignored paths under `data/`. |
| `.env.example` | modify | Drop `TELEGRAM_CHAT_ID`, add `OPERATOR_USER_ID`. |
| `test/db.test.ts` | rewrite | Argless sessions; jid-free `insertMessage`. |
| `test/scaffold.test.ts` | rewrite | New layout assertions. |
| `test/bootstrap.test.ts` | rewrite | Argless. |
| `test/outbox.test.ts` | rewrite | Argless, single outbox. |
| `test/slug.test.ts` | unchanged | — |

---

## Task 1: Rewrite the DB layer (TDD)

**Files:**
- Modify: `src/db.ts`
- Test: `test/db.test.ts`

The `messages` table loses `chat_jid` and `thread_id`. The `sessions` table is keyed on a single `key` column; in practice we only store `'life'`. All `getSession`/`setSession`/`clearSession` become argless.

- [ ] **Step 1: Replace the test file content**

Overwrite `test/db.test.ts` with:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearSession,
  closeDb,
  getDb,
  getSession,
  insertMessage,
  openDb,
  setSession,
} from '../src/db.js';

describe('db', () => {
  beforeEach(() => {
    openDb(':memory:');
  });
  afterEach(() => {
    closeDb();
  });

  it('insertMessage is idempotent on telegram_msg_id', () => {
    const row = {
      telegramMsgId: '1',
      senderId: 'u1',
      senderName: 'Alice',
      content: 'hi',
      timestamp: '2026-05-25T10:00:00Z',
    };
    insertMessage(row);
    insertMessage(row);
    const count = getDb()
      .prepare('SELECT COUNT(*) AS n FROM messages')
      .get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('insertMessage stores bot flag', () => {
    insertMessage({
      telegramMsgId: 'bot_1',
      senderId: 'bot',
      senderName: 'bot',
      content: 'reply',
      timestamp: '2026-05-25T10:00:00Z',
      isBot: true,
    });
    const row = getDb()
      .prepare('SELECT is_bot FROM messages WHERE telegram_msg_id = ?')
      .get('bot_1') as { is_bot: number };
    expect(row.is_bot).toBe(1);
  });

  it('sessions upsert and clear (single life session)', () => {
    expect(getSession()).toBeNull();
    setSession('sess-abc');
    expect(getSession()).toBe('sess-abc');
    setSession('sess-def');
    expect(getSession()).toBe('sess-def');
    clearSession();
    expect(getSession()).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/db.test.ts`
Expected: FAIL — current `insertMessage` requires `chatJid`/`threadId`; `getSession`/`setSession`/`clearSession` take a JID argument.

- [ ] **Step 3: Rewrite `src/db.ts`**

Overwrite `src/db.ts` with:

```ts
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { DB_PATH } from './config.js';
import { logger } from './logger.js';

const SESSION_KEY = 'life';

export interface NewMessage {
  telegramMsgId: string;
  senderId: string;
  senderName: string | null;
  content: string;
  timestamp: string;
  isBot?: boolean;
}

let db: Database.Database;

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_msg_id TEXT NOT NULL UNIQUE,
      sender_id       TEXT NOT NULL,
      sender_name     TEXT,
      content         TEXT NOT NULL,
      timestamp       TEXT NOT NULL,
      is_bot          INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS sessions (
      key        TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

export function openDb(dbPath: string = DB_PATH): Database.Database {
  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
  const database = new Database(dbPath);
  database.pragma('journal_mode = WAL');
  createSchema(database);
  db = database;
  logger.debug({ dbPath }, 'db opened');
  return database;
}

export function getDb(): Database.Database {
  if (!db) throw new Error('db not initialized — call openDb() first');
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = undefined as unknown as Database.Database;
  }
}

export function insertMessage(m: NewMessage): number {
  const row = getDb()
    .prepare(
      `INSERT OR IGNORE INTO messages
       (telegram_msg_id, sender_id, sender_name, content, timestamp, is_bot)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      m.telegramMsgId,
      m.senderId,
      m.senderName,
      m.content,
      m.timestamp,
      m.isBot ? 1 : 0,
    );
  return Number(row.lastInsertRowid);
}

export function getSession(): string | null {
  const row = getDb()
    .prepare('SELECT session_id FROM sessions WHERE key = ?')
    .get(SESSION_KEY) as { session_id: string } | undefined;
  return row?.session_id ?? null;
}

export function setSession(sessionId: string): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO sessions (key, session_id, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         session_id = excluded.session_id,
         updated_at = excluded.updated_at`,
    )
    .run(SESSION_KEY, sessionId, now);
}

export function clearSession(): void {
  getDb().prepare('DELETE FROM sessions WHERE key = ?').run(SESSION_KEY);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/db.test.ts`
Expected: PASS — 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/db.ts test/db.test.ts
git commit -m "refactor(db): collapse to single-operator schema

Drop chat_jid/thread_id from messages; sessions table now keyed
by a single 'life' row. Argless session accessors."
```

---

## Task 2: Flatten the memory layer (TDD)

**Files:**
- Modify: `src/memory/scaffold.ts`
- Modify: `src/memory/bootstrap.ts`
- Modify: `src/memory/log.ts`
- Modify: `src/memory/outbox.ts`
- Delete: `src/memory/threads.ts`
- Test: `test/scaffold.test.ts`
- Test: `test/bootstrap.test.ts`
- Test: `test/outbox.test.ts`

The memory layer becomes argless: one wiki under `data/wiki/`, one `data/index.md`, one `data/log.md`, one `data/outbox/`.

- [ ] **Step 1: Replace `test/scaffold.test.ts`**

Overwrite with:

```ts
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const realCwd = process.cwd();
let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-scaffold-'));
  process.chdir(tmpRoot);
  vi.resetModules();
});
afterEach(() => {
  process.chdir(realCwd);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('ensureDataLayout', () => {
  it('creates wiki/, outbox/, skills/ and seeds index.md + log.md on first run', async () => {
    const { ensureDataLayout, dataDir, skillsDir } = await import(
      '../src/memory/scaffold.js'
    );
    const created = ensureDataLayout();
    expect(created).toBe(true);
    expect(fs.statSync(path.join(dataDir(), 'wiki')).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(dataDir(), 'outbox')).isDirectory()).toBe(true);
    expect(fs.statSync(skillsDir()).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(dataDir(), 'index.md'), 'utf-8')).toContain('# Wiki index');
    expect(fs.readFileSync(path.join(dataDir(), 'log.md'), 'utf-8')).toContain('# Activity log');
    // CLAUDE.md ships in git, not generated.
    expect(fs.existsSync(path.join(dataDir(), 'CLAUDE.md'))).toBe(false);
  });

  it('does not create the legacy threads/ folder', async () => {
    const { ensureDataLayout, dataDir } = await import('../src/memory/scaffold.js');
    ensureDataLayout();
    expect(fs.existsSync(path.join(dataDir(), 'threads'))).toBe(false);
  });

  it('preserves existing index.md and log.md (idempotent)', async () => {
    const { ensureDataLayout, dataDir } = await import('../src/memory/scaffold.js');
    ensureDataLayout();
    fs.writeFileSync(path.join(dataDir(), 'index.md'), '# customised\n');
    const created = ensureDataLayout();
    expect(created).toBe(false);
    expect(fs.readFileSync(path.join(dataDir(), 'index.md'), 'utf-8')).toBe('# customised\n');
  });
});
```

- [ ] **Step 2: Replace `test/bootstrap.test.ts`**

Overwrite with:

```ts
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const realCwd = process.cwd();
let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-bootstrap-'));
  process.chdir(tmpRoot);
  vi.resetModules();
});
afterEach(() => {
  process.chdir(realCwd);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

async function setup(opts: { index?: string; log?: string; skills?: Record<string, string> }) {
  const { ensureDataLayout, dataDir, skillsDir } = await import('../src/memory/scaffold.js');
  ensureDataLayout();
  if (opts.index !== undefined) fs.writeFileSync(path.join(dataDir(), 'index.md'), opts.index);
  if (opts.log !== undefined) fs.writeFileSync(path.join(dataDir(), 'log.md'), opts.log);
  if (opts.skills) {
    for (const [name, content] of Object.entries(opts.skills)) {
      fs.writeFileSync(path.join(skillsDir(), name), content);
    }
  }
}

describe('buildBootstrapPrefix', () => {
  it('returns empty string when index, log, and skills are all empty', async () => {
    await setup({ index: '', log: '' });
    const { buildBootstrapPrefix } = await import('../src/memory/bootstrap.js');
    expect(buildBootstrapPrefix()).toBe('');
  });

  it('emits <wiki_index> and <recent_activity> blocks', async () => {
    await setup({
      index: '# Wiki index\n\n## Pages\n- foo.md — Foo Corp note',
      log: '# Activity log\n\n2026-05-25 09:00 — first turn.\n2026-05-25 10:00 — [note] foo',
    });
    const { buildBootstrapPrefix } = await import('../src/memory/bootstrap.js');
    const prefix = buildBootstrapPrefix();
    expect(prefix).toContain('<wiki_index>');
    expect(prefix).toContain('# Wiki index');
    expect(prefix).toContain('</wiki_index>');
    expect(prefix).toContain('<recent_activity>');
    expect(prefix).toContain('[note] foo');
    expect(prefix.endsWith('\n\n')).toBe(true);
  });

  it('emits <skills> from data/skills/', async () => {
    await setup({
      index: '# Wiki index\nempty',
      skills: { 'prune-wiki.md': '# Prune wiki — sweep the wiki\nrest...' },
    });
    const { buildBootstrapPrefix } = await import('../src/memory/bootstrap.js');
    const prefix = buildBootstrapPrefix();
    expect(prefix).toContain('<skills>');
    expect(prefix).toContain('skills/prune-wiki.md — Prune wiki — sweep the wiki');
  });
});
```

- [ ] **Step 3: Replace `test/outbox.test.ts`**

Overwrite with:

```ts
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const realCwd = process.cwd();
let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-outbox-'));
  process.chdir(tmpRoot);
  vi.resetModules();
});
afterEach(() => {
  process.chdir(realCwd);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function outboxDir(): string {
  return path.join(tmpRoot, 'data', 'outbox');
}

describe('outbox', () => {
  it('returns empty when no outbox dir exists', async () => {
    const { listOutbox } = await import('../src/memory/outbox.js');
    expect(listOutbox()).toEqual([]);
  });

  it('lists files, pairs with .caption siblings, classifies image vs document', async () => {
    fs.mkdirSync(outboxDir(), { recursive: true });
    fs.writeFileSync(path.join(outboxDir(), 'report.pdf'), 'pdf-bytes');
    fs.writeFileSync(path.join(outboxDir(), 'report.pdf.caption'), 'Q1 roll-up');
    fs.writeFileSync(path.join(outboxDir(), 'chart.png'), 'png-bytes');

    const { listOutbox } = await import('../src/memory/outbox.js');
    const files = listOutbox().sort((a, b) => a.filename.localeCompare(b.filename));
    expect(files).toHaveLength(2);
    const chart = files.find((f) => f.filename === 'chart.png')!;
    const report = files.find((f) => f.filename === 'report.pdf')!;
    expect(chart.fileType).toBe('image');
    expect(chart.caption).toBeUndefined();
    expect(report.fileType).toBe('document');
    expect(report.caption).toBe('Q1 roll-up');
  });

  it('removeOutboxFile deletes both file and caption sibling', async () => {
    fs.mkdirSync(outboxDir(), { recursive: true });
    fs.writeFileSync(path.join(outboxDir(), 'x.pdf'), 'x');
    fs.writeFileSync(path.join(outboxDir(), 'x.pdf.caption'), 'cap');

    const { listOutbox, removeOutboxFile } = await import('../src/memory/outbox.js');
    const [file] = listOutbox();
    removeOutboxFile(file);
    expect(fs.existsSync(path.join(outboxDir(), 'x.pdf'))).toBe(false);
    expect(fs.existsSync(path.join(outboxDir(), 'x.pdf.caption'))).toBe(false);
  });
});
```

- [ ] **Step 4: Run all three memory tests to verify they fail**

Run: `npx vitest run test/scaffold.test.ts test/bootstrap.test.ts test/outbox.test.ts`
Expected: FAIL — current modules reference `threadsRoot`, `threadIndexFile`, `threadOutboxDir`, etc.

- [ ] **Step 5: Rewrite `src/memory/scaffold.ts`**

```ts
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';

export function dataDir(): string {
  return DATA_DIR;
}

export function skillsDir(): string {
  return path.join(DATA_DIR, 'skills');
}

export function wikiDir(): string {
  return path.join(DATA_DIR, 'wiki');
}

export function outboxDir(): string {
  return path.join(DATA_DIR, 'outbox');
}

export function indexFile(): string {
  return path.join(DATA_DIR, 'index.md');
}

export function logFile(): string {
  return path.join(DATA_DIR, 'log.md');
}

/**
 * Idempotently create the data/ skeleton: wiki/, outbox/, skills/, and seed
 * index.md + log.md if missing. data/CLAUDE.md ships in git.
 */
export function ensureDataLayout(): boolean {
  let created = false;
  for (const dir of [wikiDir(), outboxDir(), skillsDir()]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      created = true;
    }
  }
  if (!fs.existsSync(indexFile())) {
    fs.writeFileSync(
      indexFile(),
      '# Wiki index\n\nNo pages yet. As you build up notes in `wiki/`, list them here with a one-line summary.\n',
    );
    created = true;
  }
  if (!fs.existsSync(logFile())) {
    fs.writeFileSync(
      logFile(),
      `# Activity log\n\n${new Date().toISOString()} — data layout created.\n`,
    );
    created = true;
  }
  if (created) logger.info({ dir: DATA_DIR }, 'data layout ready');
  return created;
}
```

- [ ] **Step 6: Rewrite `src/memory/bootstrap.ts`**

```ts
import fs from 'fs';
import path from 'path';

import { indexFile, skillsDir } from './scaffold.js';
import { readLogTail } from './log.js';

function readIfExists(file: string): string {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8').trim() : '';
}

function listSkills(): string {
  const dir = skillsDir();
  if (!fs.existsSync(dir)) return '';
  const lines: string[] = [];
  const files = fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => e.name)
    .sort();
  for (const name of files) {
    let title = '';
    try {
      const content = fs.readFileSync(path.join(dir, name), 'utf-8');
      const first = content.split('\n').find((l) => l.trim().length > 0) ?? '';
      title = first.replace(/^#+\s*/, '').trim();
    } catch {
      /* unreadable; fall through */
    }
    lines.push(title ? `skills/${name} — ${title}` : `skills/${name}`);
  }
  return lines.join('\n');
}

/**
 * Build the prompt prefix: wiki index, recent log tail, and the global
 * skills catalog. Used at the top of every agent turn.
 */
export function buildBootstrapPrefix(): string {
  const index = readIfExists(indexFile());
  const logTail = readLogTail(20);
  const skills = listSkills();

  const parts: string[] = [];
  if (index) parts.push(`<wiki_index>\n${index}\n</wiki_index>`);
  if (logTail) parts.push(`<recent_activity>\n${logTail}\n</recent_activity>`);
  if (skills) parts.push(`<skills>\n${skills}\n</skills>`);

  return parts.length ? parts.join('\n\n') + '\n\n' : '';
}
```

- [ ] **Step 7: Rewrite `src/memory/log.ts`**

```ts
import fs from 'fs';

import { logFile } from './scaffold.js';

function stamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export function appendLogEntry(summary: string, tag?: string): void {
  const file = logFile();
  if (!fs.existsSync(file)) return;
  const prefix = tag ? `[${tag}] ` : '';
  const line = `${stamp()} — ${prefix}${summary.replace(/\s+/g, ' ').slice(0, 300)}\n`;
  fs.appendFileSync(file, line);
}

export function readLogTail(lines = 20): string {
  const file = logFile();
  if (!fs.existsSync(file)) return '';
  const content = fs.readFileSync(file, 'utf-8');
  const split = content.trimEnd().split('\n');
  return split.slice(-lines).join('\n');
}
```

- [ ] **Step 8: Rewrite `src/memory/outbox.ts`**

```ts
import fs from 'fs';
import path from 'path';

import { outboxDir } from './scaffold.js';

export interface OutboxFile {
  absPath: string;
  filename: string;
  caption?: string;
  fileType: 'image' | 'document';
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

function classify(ext: string): 'image' | 'document' {
  return IMAGE_EXTS.has(ext.toLowerCase()) ? 'image' : 'document';
}

export function listOutbox(): OutboxFile[] {
  const dir = outboxDir();
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: OutboxFile[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (e.name.endsWith('.caption')) continue;
    const abs = path.join(dir, e.name);
    const captionPath = abs + '.caption';
    let caption: string | undefined;
    if (fs.existsSync(captionPath)) {
      const raw = fs.readFileSync(captionPath, 'utf-8').trim();
      if (raw) caption = raw.slice(0, 1024);
    }
    files.push({
      absPath: abs,
      filename: e.name,
      caption,
      fileType: classify(path.extname(e.name)),
    });
  }
  return files;
}

export function removeOutboxFile(file: OutboxFile): void {
  try {
    fs.unlinkSync(file.absPath);
  } catch {
    /* best-effort */
  }
  const captionPath = file.absPath + '.caption';
  if (fs.existsSync(captionPath)) {
    try {
      fs.unlinkSync(captionPath);
    } catch {
      /* best-effort */
    }
  }
}
```

- [ ] **Step 9: Delete `src/memory/threads.ts`**

Run: `git rm src/memory/threads.ts`

- [ ] **Step 10: Run the memory tests to verify they pass**

Run: `npx vitest run test/scaffold.test.ts test/bootstrap.test.ts test/outbox.test.ts`
Expected: PASS — all assertions green.

- [ ] **Step 11: Commit**

```bash
git add src/memory test/scaffold.test.ts test/bootstrap.test.ts test/outbox.test.ts
git commit -m "refactor(memory): flatten per-thread layout into data/

Move wiki/, outbox/, index.md, log.md to data/ directly. Delete
src/memory/threads.ts. All memory helpers become argless."
```

---

## Task 3: Drop `threadJid` from the agent runner

**Files:**
- Modify: `src/agent-runner.ts`

The runner doesn't need a JID — it only used it for log fields and to call `clearSession(threadJid)`.

- [ ] **Step 1: Rewrite `src/agent-runner.ts`**

```ts
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';

import { AGENT_IDLE_TIMEOUT_MS, AGENT_TIMEOUT_MS } from './config.js';
import { clearSession } from './db.js';
import { logger } from './logger.js';
import { dataDir } from './memory/scaffold.js';
import type { AgentEventHandler, AgentInput, AgentOutput } from './agent-types.js';

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const STALE_SESSION_RE = /No conversation found with session ID/i;

/**
 * Spawn `claude` as a subprocess and stream output events back to the caller.
 *
 * The caller controls `cwd` (defaults to data/) and is responsible for
 * prepending any context prefix to `prompt`. Slash commands should be
 * sent unmodified. Session resumption is via `--resume <sessionId>`;
 * callers persist the new session ID emitted via `system/init`.
 */
export async function runAgent(
  input: AgentInput,
  onEvent: AgentEventHandler,
): Promise<AgentOutput> {
  const result = await runAgentInner(input, onEvent);
  if (
    result.status === 'error' &&
    input.sessionId &&
    result.error &&
    STALE_SESSION_RE.test(result.error)
  ) {
    logger.warn({ sessionId: input.sessionId }, 'session stale — clearing and retrying fresh');
    clearSession();
    return runAgentInner({ ...input, sessionId: undefined }, onEvent);
  }
  return result;
}

async function runAgentInner(
  input: AgentInput,
  onEvent: AgentEventHandler,
): Promise<AgentOutput> {
  const cwd = input.cwd ?? dataDir();
  if (!fs.existsSync(cwd)) {
    return { status: 'error', result: null, error: `cwd missing: ${cwd}` };
  }

  const args = [
    '-p',
    input.prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'bypassPermissions',
  ];

  if (input.sessionId) args.push('--resume', input.sessionId);

  logger.info({ sessionId: input.sessionId, cwd }, 'Spawning agent');

  return new Promise<AgentOutput>((resolve) => {
    const proc: ChildProcess = spawn(CLAUDE_BIN, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stdoutBuf = '';
    let stderrTail = '';
    let newSessionId: string | undefined;
    let lastAssistantText = '';
    let hadOutput = false;
    let eventChain: Promise<void> = Promise.resolve();

    let hardTimeout = setTimeout(() => {
      logger.warn({}, 'agent hard timeout');
      proc.kill('SIGTERM');
    }, AGENT_TIMEOUT_MS);
    let idleTimeout = setTimeout(() => {
      logger.warn({}, 'agent idle timeout');
      proc.kill('SIGTERM');
    }, AGENT_IDLE_TIMEOUT_MS);
    const resetIdle = () => {
      clearTimeout(idleTimeout);
      idleTimeout = setTimeout(() => proc.kill('SIGTERM'), AGENT_IDLE_TIMEOUT_MS);
    };

    const emit = (ev: AgentOutput) => {
      if (ev.newSessionId) newSessionId = ev.newSessionId;
      eventChain = eventChain.then(async () => {
        try {
          await onEvent(ev);
        } catch (err) {
          logger.error({ err }, 'agent onEvent handler threw');
        }
      });
      hadOutput = true;
      resetIdle();
    };

    proc.stdout?.on('data', (data: Buffer) => {
      stdoutBuf += data.toString();
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() ?? '';
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        let msg: {
          type?: string;
          subtype?: string;
          session_id?: string;
          message?: { content?: Array<{ type?: string; text?: string }> };
          result?: string;
        };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.session_id) newSessionId = msg.session_id;
        if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) {
          emit({ status: 'success', result: null, newSessionId: msg.session_id });
          continue;
        }
        if (msg.type === 'assistant' && msg.message?.content) {
          const text = msg.message.content
            .filter((b) => b.type === 'text' && typeof b.text === 'string')
            .map((b) => b.text as string)
            .join('');
          if (text) {
            lastAssistantText = text;
            emit({ status: 'success', result: text, newSessionId });
          }
        }
        if (msg.type === 'result') {
          const finalText = (typeof msg.result === 'string' && msg.result) || lastAssistantText;
          if (finalText && finalText !== lastAssistantText) {
            emit({ status: 'success', result: finalText, newSessionId });
          }
        }
      }
    });

    proc.stderr?.on('data', (data: Buffer) => {
      const chunk = data.toString();
      stderrTail = (stderrTail + chunk).slice(-2000);
      for (const l of chunk.trim().split('\n')) {
        if (l) logger.debug({}, l);
      }
    });

    proc.on('close', (code) => {
      clearTimeout(hardTimeout);
      clearTimeout(idleTimeout);
      eventChain.then(() => {
        if (code !== 0 && !hadOutput) {
          resolve({
            status: 'error',
            result: null,
            error: `claude exited ${code}: ${stderrTail.slice(-400)}`,
          });
          return;
        }
        resolve({
          status: 'success',
          result: lastAssistantText || null,
          newSessionId,
        });
      });
    });

    proc.on('error', (err) => {
      clearTimeout(hardTimeout);
      clearTimeout(idleTimeout);
      logger.error({ err }, 'agent spawn error');
      resolve({ status: 'error', result: null, error: `spawn error: ${err.message}` });
    });
  });
}
```

- [ ] **Step 2: Verify the file parses**

Run: `npx tsc --noEmit src/agent-runner.ts 2>&1 | head -20`
Expected: The agent-runner file itself has no syntax errors. Cross-file errors in `db.ts` / `scaffold.ts` are now resolved from Tasks 1 + 2, but consumers (`index.ts`, `weekly-prune.ts`) still pass `threadJid` — those errors are expected and will be fixed in Tasks 7 + 8. Do not block on them.

- [ ] **Step 3: Commit**

```bash
git add src/agent-runner.ts
git commit -m "refactor(agent): drop threadJid arg from runAgent

clearSession() is now argless; logging tags simplified."
```

---

## Task 4: Update config + env

**Files:**
- Modify: `src/config.ts`
- Modify: `src/env.ts`
- Modify: `.env.example`

- [ ] **Step 1: Rewrite `src/config.ts`**

```ts
import path from 'path';

import { readEnvFile } from './env.js';

const envConfig = readEnvFile(['TELEGRAM_BOT_TOKEN', 'OPERATOR_USER_ID']);

function fromEnv(key: string): string | undefined {
  return process.env[key] || envConfig[key];
}

export const TELEGRAM_BOT_TOKEN = fromEnv('TELEGRAM_BOT_TOKEN') || '';
export const OPERATOR_USER_ID = fromEnv('OPERATOR_USER_ID') || '';

const PROJECT_ROOT = process.cwd();
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
const STATE_DIR = path.resolve(PROJECT_ROOT, 'state');
export const DB_PATH = path.join(STATE_DIR, 'messages.db');

// Agent subprocess behaviour
export const AGENT_TIMEOUT_MS = 30 * 60 * 1000; // 30 min hard cap per turn
export const AGENT_IDLE_TIMEOUT_MS = 10 * 60 * 1000; // kill if no output for 10 min
```

- [ ] **Step 2: `src/env.ts` is unchanged**

It already accepts an arbitrary list of keys. No edit needed.

- [ ] **Step 3: Rewrite `.env.example`**

```env
# Telegram bot — create via @BotFather
TELEGRAM_BOT_TOKEN=

# The numeric Telegram user id allowed to DM this bot. Anyone else is
# ignored. Leave empty to bootstrap: any DM you send while empty replies
# with your user id; paste it here and restart.
OPERATOR_USER_ID=

# IANA timezone for log timestamps (e.g. America/Los_Angeles). Defaults to UTC.
TZ=UTC

# pino log level: trace | debug | info | warn | error | fatal
LOG_LEVEL=info
```

- [ ] **Step 4: Commit**

```bash
git add src/config.ts .env.example
git commit -m "refactor(config): swap TELEGRAM_CHAT_ID for OPERATOR_USER_ID

Single-operator DM gate replaces supergroup chat gate."
```

---

## Task 5: Rewrite admin commands

**Files:**
- Modify: `src/admin-commands.ts`

`/chatid` becomes `/whoami` (reports caller's user id and operator status). `/ping` and `/help` stay.

- [ ] **Step 1: Rewrite `src/admin-commands.ts`**

```ts
import { OPERATOR_USER_ID } from './config.js';

export interface AdminCtx {
  command: string;
  args: string;
  callerUserId: string;
}

export interface AdminResult {
  handled: boolean;
  reply?: string;
}

export function handlePing(): AdminResult {
  return { handled: true, reply: 'pong' };
}

export function handleWhoami(callerUserId: string): AdminResult {
  const isOperator = OPERATOR_USER_ID && callerUserId === OPERATOR_USER_ID;
  const status = OPERATOR_USER_ID
    ? isOperator
      ? '(configured operator)'
      : `(not the configured operator — operator is ${OPERATOR_USER_ID})`
    : '(no operator configured — paste this into OPERATOR_USER_ID and restart)';
  return {
    handled: true,
    reply: `your_user_id: ${callerUserId} ${status}`,
  };
}

export function handleHelp(): AdminResult {
  const lines = [
    '*Commands*',
    '/whoami — show your user id and operator status',
    '/ping — health check',
    '',
    'Any other /command (e.g. /compact, /model, /clear) is forwarded to the claude subprocess.',
  ];
  return { handled: true, reply: lines.join('\n') };
}

export async function handleAdminCommand(ctx: AdminCtx): Promise<AdminResult> {
  switch (ctx.command) {
    case 'ping':
      return handlePing();
    case 'whoami':
      return handleWhoami(ctx.callerUserId);
    case 'help':
      return handleHelp();
    default:
      return { handled: false };
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/admin-commands.ts
git commit -m "refactor(admin): /chatid -> /whoami

Shows caller user id and operator-match status. Bootstrap helper
when OPERATOR_USER_ID is unset."
```

---

## Task 6: Rewrite the Telegram layer

**Files:**
- Modify: `src/telegram.ts`

Drop forum-topic routing, admin-cache, `getChatAdministrators`. DM-only with single-operator gate. Helpers lose `threadId`. `ThreadMessage` → `InboundMessage`.

- [ ] **Step 1: Rewrite `src/telegram.ts`**

```ts
import { Bot, InputFile, type Api, type Context } from 'grammy';
import { run, sequentialize, type RunnerHandle } from '@grammyjs/runner';

import { OPERATOR_USER_ID, TELEGRAM_BOT_TOKEN } from './config.js';
import { insertMessage } from './db.js';
import { logger } from './logger.js';

export interface InboundMessage {
  senderId: string;
  senderName: string | null;
  chatId: number;
  content: string;
  isCommand: boolean;
  command?: string;
  commandArgs?: string;
  telegramMsgId: string;
}

export interface TelegramBotHandlers {
  /** Called on every operator DM. Should not throw — runner handles errors. */
  onMessage: (msg: InboundMessage) => Promise<void>;
}

// --- Command parsing --------------------------------------------------

function parseCommand(text: string | undefined): { command: string; args: string } | null {
  if (!text || !text.startsWith('/')) return null;
  const m = text.match(/^\/([A-Za-z][\w-]*)(?:@\w+)?\s*(.*)$/s);
  if (!m) return null;
  return { command: m[1].toLowerCase(), args: m[2].trim() };
}

// --- Outbound helpers -------------------------------------------------

const TG_MSG_MAX = 4000;

export function startTyping(api: Api, chatId: number | string): () => void {
  let stopped = false;
  const tick = (): void => {
    if (stopped) return;
    api.sendChatAction(chatId, 'typing').catch(() => {
      /* indicator is best-effort */
    });
  };
  tick();
  const timer = setInterval(tick, 4000);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export async function sendText(
  api: Api,
  chatId: number | string,
  text: string,
): Promise<{ messageId: number } | null> {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > TG_MSG_MAX) {
    const cut = remaining.lastIndexOf('\n', TG_MSG_MAX);
    const idx = cut > 0 ? cut : TG_MSG_MAX;
    chunks.push(remaining.slice(0, idx));
    remaining = remaining.slice(idx);
  }
  if (remaining) chunks.push(remaining);
  let lastId: number | null = null;
  for (const chunk of chunks) {
    const sent = await api.sendMessage(chatId, chunk);
    lastId = sent.message_id;
  }
  return lastId !== null ? { messageId: lastId } : null;
}

export async function sendFile(
  api: Api,
  chatId: number | string,
  absPath: string,
  kind: 'image' | 'document',
  caption?: string,
): Promise<void> {
  const input = new InputFile(absPath);
  const opts: { caption?: string } = {};
  if (caption) opts.caption = caption;
  if (kind === 'image') {
    await api.sendPhoto(chatId, input, opts);
  } else {
    await api.sendDocument(chatId, input, opts);
  }
}

// --- Operator gating --------------------------------------------------

/**
 * Bootstrap mode (`OPERATOR_USER_ID` empty): any DM gets a reply containing
 * the sender's user id, then no further processing. Once `OPERATOR_USER_ID`
 * is set, only that user id can drive the agent in a private chat. Group
 * chats are ignored entirely.
 */
function isAuthorized(ctx: Context): boolean {
  if (ctx.chat?.type !== 'private') return false;
  const from = ctx.from?.id;
  if (from === undefined) return false;
  return String(from) === OPERATOR_USER_ID;
}

// --- Main bot entrypoint ----------------------------------------------

export function createBot(handlers: TelegramBotHandlers): Bot {
  if (!TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN not set');
  const bot = new Bot(TELEGRAM_BOT_TOKEN);

  bot.api
    .setMyCommands([
      { command: 'whoami', description: 'Show your user id and operator status' },
      { command: 'ping', description: 'Health check' },
      { command: 'help', description: 'Show commands' },
    ])
    .catch((err) => logger.warn({ err }, 'setMyCommands failed'));

  // Serialize updates per chat (in practice always one operator chat).
  bot.use(
    sequentialize((ctx) => {
      const chat = ctx.chat?.id;
      return chat === undefined ? undefined : String(chat);
    }),
  );

  let bootstrapWarned = false;

  bot.on('message', async (ctx) => {
    try {
      if (ctx.chat?.type !== 'private') return;
      const chatId = ctx.chat.id;
      const fromId = ctx.from?.id;
      if (fromId === undefined) return;
      const senderId = String(fromId);
      const senderName = ctx.from?.username || ctx.from?.first_name || null;
      const text = ctx.message?.text;
      const parsed = parseCommand(text);

      // Bootstrap mode: no operator configured yet.
      if (!OPERATOR_USER_ID) {
        if (!bootstrapWarned) {
          logger.warn({}, 'OPERATOR_USER_ID not set — bootstrap mode. Set it once you know your user id.');
          bootstrapWarned = true;
        }
        await ctx.api.sendMessage(
          chatId,
          `your_user_id: ${senderId}\n\nPaste this into OPERATOR_USER_ID in .env and restart.`,
        );
        return;
      }

      // Authorized operator gate.
      if (!isAuthorized(ctx)) {
        logger.debug({ senderId }, 'unauthorized DM ignored');
        return;
      }

      const content = ctx.message?.text ?? ctx.message?.caption ?? '';
      insertMessage({
        telegramMsgId: String(ctx.message?.message_id ?? Date.now()),
        senderId,
        senderName,
        content,
        timestamp: new Date().toISOString(),
      });

      await handlers.onMessage({
        senderId,
        senderName,
        chatId,
        content,
        isCommand: !!parsed,
        command: parsed?.command,
        commandArgs: parsed?.args,
        telegramMsgId: String(ctx.message?.message_id ?? ''),
      });
    } catch (err) {
      logger.error({ err }, 'Unhandled error in message handler');
      try {
        const chatId = ctx.chat?.id;
        if (typeof chatId === 'number') {
          await sendText(ctx.api, chatId, `[error: ${(err as Error).message ?? err}]`);
        }
      } catch {
        /* best effort */
      }
    }
  });

  bot.catch((err) => {
    logger.error({ err: err.error }, 'Bot runtime error');
  });

  return bot;
}

export async function startBot(bot: Bot): Promise<RunnerHandle> {
  const me = await bot.api.getMe();
  logger.info({ username: me.username, id: me.id }, 'Telegram bot online');
  return run(bot);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/telegram.ts
git commit -m "refactor(telegram): DM-only, single-operator gate

InboundMessage replaces ThreadMessage. sendText/sendFile drop the
message_thread_id arg. Forum-topic routing and admin cache removed."
```

---

## Task 7: Rewrite the orchestrator

**Files:**
- Modify: `src/index.ts`

Single mutex slug `'life'`, single pending-queue, argless calls to memory + DB + agent.

- [ ] **Step 1: Rewrite `src/index.ts`**

```ts
import { setDefaultResultOrder } from 'node:dns';

import { Bot } from 'grammy';

// WSL2 (and some IPv6-broken hosts) can resolve api.telegram.org to an IPv6
// address that refuses connections, causing Grammy to hang until ETIMEDOUT.
// Force IPv4-first so outbound HTTPS picks a reachable route.
setDefaultResultOrder('ipv4first');

import { handleAdminCommand } from './admin-commands.js';
import { runAgent } from './agent-runner.js';
import {
  getSession,
  insertMessage,
  openDb,
  setSession,
} from './db.js';
import { logger } from './logger.js';
import { buildBootstrapPrefix } from './memory/bootstrap.js';
import { appendLogEntry } from './memory/log.js';
import { listOutbox, removeOutboxFile } from './memory/outbox.js';
import { dataDir, ensureDataLayout } from './memory/scaffold.js';
import { TopicMutex } from './mutex.js';
import {
  createBot,
  sendFile,
  sendText,
  startBot,
  startTyping,
  type InboundMessage,
} from './telegram.js';

const LIFE = 'life';
const mutex = new TopicMutex();
const pendingMessages: InboundMessage[] = [];

async function drainOutbox(bot: Bot, msg: InboundMessage): Promise<void> {
  const files = listOutbox();
  for (const f of files) {
    try {
      await sendFile(bot.api, msg.chatId, f.absPath, f.fileType, f.caption);
      removeOutboxFile(f);
    } catch (err) {
      logger.error({ file: f.filename, err }, 'outbox send failed');
    }
  }
}

const SLASH_RE = /^\/[A-Za-z][\w-]*(?:\s|$)/;

async function runTurn(
  bot: Bot,
  msg: InboundMessage,
  promptOverride?: string,
): Promise<void> {
  const prompt = promptOverride ?? msg.content;
  const sessionId = getSession() ?? undefined;
  const isSlashCommand = SLASH_RE.test(prompt.trim());
  const finalPrompt = isSlashCommand ? prompt : buildBootstrapPrefix() + prompt;

  const stopTyping = startTyping(bot.api, msg.chatId);

  try {
    let lastSent = '';
    let sentAny = false;
    const result = await runAgent(
      { prompt: finalPrompt, sessionId, cwd: dataDir() },
      async (ev) => {
        if (ev.newSessionId) setSession(ev.newSessionId);
        if (ev.status === 'success' && ev.result && ev.result !== lastSent) {
          lastSent = ev.result;
          sentAny = true;
          try {
            await sendText(bot.api, msg.chatId, ev.result);
          } catch (err) {
            logger.error({ err }, 'sendMessage failed');
          }
        }
      },
    );

    if (result.status === 'error') {
      await sendText(
        bot.api,
        msg.chatId,
        `[agent error] ${result.error ?? 'unknown failure'}`,
      );
    } else if (!sentAny && result.result) {
      await sendText(bot.api, msg.chatId, result.result);
    }

    await drainOutbox(bot, msg);

    const summary = (result.result ?? '').slice(0, 180).replace(/\s+/g, ' ');
    if (summary) appendLogEntry(summary);
  } finally {
    stopTyping();
  }
}

async function onMessage(bot: Bot, msg: InboundMessage): Promise<void> {
  // Route bot-local commands without spawning the agent.
  if (msg.isCommand && msg.command) {
    const adminRes = await handleAdminCommand({
      command: msg.command,
      args: msg.commandArgs ?? '',
      callerUserId: msg.senderId,
    });
    if (adminRes.handled) {
      if (adminRes.reply) {
        await sendText(bot.api, msg.chatId, adminRes.reply);
      }
      return;
    }
    // Unknown /command — pass through to claude CLI below.
  }

  if (mutex.isLocked(LIFE)) {
    pendingMessages.push(msg);
    return;
  }

  await mutex.acquire(LIFE);
  try {
    await runTurn(bot, msg);
    for (;;) {
      if (pendingMessages.length === 0) break;
      const drained = pendingMessages.splice(0, pendingMessages.length);
      const combined = drained
        .map((p) => `[from ${p.senderName ?? p.senderId}] ${p.content}`)
        .join('\n\n');
      await runTurn(bot, { ...msg, content: combined }, combined);
    }
  } finally {
    mutex.release(LIFE);
  }
}

async function main(): Promise<void> {
  ensureDataLayout();
  openDb();

  const bot = createBot({
    onMessage: (msg) => onMessage(bot, msg),
  });

  // Record bot-authored outbound messages for history.
  bot.api.config.use(async (prev, method, payload, signal) => {
    const res = await prev(method, payload, signal);
    if (method === 'sendMessage' || method === 'sendDocument' || method === 'sendPhoto') {
      const p = payload as Record<string, unknown>;
      const text = (method === 'sendMessage' ? (p.text as string) : (p.caption as string)) ?? '';
      if (text) {
        insertMessage({
          telegramMsgId: `bot_${Date.now()}`,
          senderId: 'bot',
          senderName: 'bot',
          content: text,
          timestamp: new Date().toISOString(),
          isBot: true,
        });
      }
    }
    return res;
  });

  const handle = await startBot(bot);

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    try {
      await handle.stop();
    } catch (err) {
      logger.warn({ err }, 'runner stop failed');
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await handle.task();
}

main().catch((err) => {
  logger.fatal({ err }, 'fatal');
  process.exit(1);
});
```

- [ ] **Step 2: Commit**

```bash
git add src/index.ts
git commit -m "refactor(index): single 'life' mutex and pending queue

Argless memory/DB calls, single onMessage handler, agent cwd=data/."
```

---

## Task 8: Rewrite the weekly-prune script

**Files:**
- Modify: `scripts/weekly-prune.ts`

Drop the synthetic `cli:weekly-prune` JID — prune shares the `'life'` session. Prompt rewritten for single-wiki mode.

- [ ] **Step 1: Rewrite `scripts/weekly-prune.ts`**

```ts
#!/usr/bin/env tsx
/**
 * Weekly job: tell the agent to walk data/wiki/ and apply the prune-wiki
 * skill. Invoked by a systemd timer (see systemd/icarus-prune.timer).
 * Shares the same Claude session as the live bot.
 */
import { setDefaultResultOrder } from 'node:dns';
setDefaultResultOrder('ipv4first');

import { runAgent } from '../src/agent-runner.js';
import { getSession, openDb, setSession } from '../src/db.js';
import { logger } from '../src/logger.js';
import { dataDir, ensureDataLayout } from '../src/memory/scaffold.js';

const PROMPT = [
  'Weekly wiki prune.',
  '',
  'Run the prune-wiki skill (data/skills/prune-wiki.md) against this wiki: walk data/wiki/, apply the procedure to index.md and the pages, and surface ambiguous candidates into data/outbox/.',
  '',
  'Reply with a one-paragraph summary including counts (deleted, merged, flagged).',
].join('\n');

async function main(): Promise<void> {
  ensureDataLayout();
  openDb();

  const sessionId = getSession() ?? undefined;
  let lastText = '';
  const started = Date.now();

  const res = await runAgent(
    { prompt: PROMPT, sessionId, cwd: dataDir() },
    async (ev) => {
      if (ev.newSessionId) setSession(ev.newSessionId);
      if (ev.result) {
        lastText = ev.result;
        const head = ev.result.split('\n').slice(0, 2).join(' ').slice(0, 160);
        if (head) process.stdout.write(`    ${head}\n`);
      }
    },
  );
  const sec = Math.round((Date.now() - started) / 1000);

  if (res.status === 'error') {
    console.error(`  ✗ FAILED: ${res.error}`);
    process.exit(1);
  }
  const tail = (lastText || res.result || '').split('\n').slice(-3).join(' ').slice(0, 300);
  console.log(`  ✓ ${tail.trim() || '(no summary text)'}`);
  console.log(`done in ${sec}s.`);
}

main().catch((err) => {
  logger.fatal({ err }, 'weekly-prune fatal');
  process.exit(1);
});
```

- [ ] **Step 2: Commit**

```bash
git add scripts/weekly-prune.ts
git commit -m "refactor(prune): single-wiki mode, shared session

Drop synthetic cli:weekly-prune JID. cwd stays data/."
```

---

## Task 9: Rewrite persona + skill markdown

**Files:**
- Modify: `data/CLAUDE.md`
- Modify: `data/skills/prune-wiki.md`

- [ ] **Step 1: Rewrite `data/CLAUDE.md`**

```markdown
# Life agent — base persona

You are the operator's life agent, driven from Telegram DMs. You run as the `claude` CLI, spawned per turn with `cwd = data/`.

> This file is the shared base persona. Fork the repo and edit this file (and `data/skills/`) to fit your deployment. See the `## Customize me` block at the bottom.

## Memory schema

Your cwd is `data/`. The shape:

```
<cwd>/                          ← data/
  CLAUDE.md                     ← this file
  index.md                      ← one-line catalog of pages in wiki/, grouped
  log.md                        ← append-only activity log, one terse line per turn
  wiki/                         ← your markdown notes
  outbox/                       ← drop a file here to deliver it to chat after the turn
  skills/<name>.md              ← global skill recipes available every turn
```

You operate on one shared wiki — there is no per-topic isolation. Everything the operator tells you lives in this single store.

## Operations

- **Query** (default). Search `wiki/` first; answer with citations to page names. If the answer isn't there and is worth keeping, write a new page, update `index.md`, then answer.
- **Note-taking.** When the user shares facts, decisions, numbers, contacts, plans, or context worth remembering, distill into a small wiki page (one entity/concept per page). Keep pages short — small pages compound better than long ones.
- **Lint** when asked: scan `wiki/` for contradictions, stale claims, and orphans (not in `index.md`). Report findings; don't auto-fix unless told.
- **Skill** when a request matches a skill title in `<skills>`, open `data/skills/<name>.md` and follow it as the recipe.

## Skills

Skills are single markdown files at `data/skills/<name>.md`. The first line is an `# H1` whose text appears in your `<skills>` block each turn. The rest of the file is the recipe.

The user can manage skills in chat — treat as plain file ops on `data/skills/`:

- "list skills" → list `data/skills/*.md` with their H1 titles.
- "add a skill called X to do Y" → create `data/skills/<kebab-name>.md` with a sensible H1 and a draft recipe. Ask for missing details only if you can't reasonably infer them.
- "edit/change the X skill so …" → edit `data/skills/<name>.md` and tell the user what changed.
- "remove/delete the X skill" → delete `data/skills/<name>.md`.

After any add/edit/remove, append a `[skills]`-tagged line to `log.md`.

## Rules

- Stay inside `data/` unless explicitly asked otherwise.
- Keep `index.md` in sync with `wiki/`.
- Append to `log.md` at the end of each turn with one terse line: `YYYY-MM-DD HH:MM — summary` (UTC), with optional `[tag]`.
- Prefer many small pages over a few long ones.
- When in doubt about a destructive change (rename, delete, large rewrite), describe it and let the user confirm.

## Standing preferences

- Prefer plain markdown tables over prose for tabular data.
- When a number is estimated, mark it `~` and say "estimate"; when it's known, state it exactly with the source.
- ISO 8601 dates (`YYYY-MM-DD`).
- When quoting prices or invoices, always include both currency and date.
- Use SI units; if a source uses imperial, include both.

## Customize me

Replace this section in your fork with deployment-specific context: who the operator is, what they do, who their people are, brand voice, anything the agent should know on every turn. Keep it tight — everything here is loaded into context for every turn.

Example shape:

```
## Operator profile

- **Name:** <name>
- **One-liner:** <what the operator does>
- **Currency:** <default>
- **Timezone:** <IANA tz>

### People

| Name | Relationship | Telegram | Notes |
|------|--------------|----------|-------|
| ...  | ...          | ...      | ...   |

### Voice rules

- ...
```
```

- [ ] **Step 2: Rewrite `data/skills/prune-wiki.md`**

```markdown
# Prune wiki — sweep `wiki/` for orphans, redundancy, and weird pages

Use this skill when the user asks to prune, clean, lint, or audit the wiki, or when the weekly timer fires it (`scripts/weekly-prune.ts`).

The skill operates on `data/wiki/` (your cwd is `data/`).

The goal: keep `wiki/` lean. Every page should have a clear topic, be cited or linked from `index.md`, and pull its weight. Bias toward keeping content over deleting it — when in doubt, surface for review rather than auto-delete.

## What to look for

1. **Orphans** — pages not listed anywhere in `index.md` and not linked from any other wiki page. Strongest delete candidates.
2. **Stubs** — pages under ~200 bytes of real content (excluding the H1) that say nothing concrete. Either flesh out or delete.
3. **Duplicates / near-duplicates** — pages whose subject overlaps another page. Merge into the canonical page; redirect by deleting the loser and updating links + `index.md`.
4. **Stale** — pages whose claimed sources or dates have clearly aged out (e.g. quote from 2024 marked "current pricing"). Either repoint, qualify, or delete.
5. **Weird** — pages with no H1, mojibake, leftover scaffolding (`TODO`, `<placeholder>`, lorem ipsum), or auto-generated slop with no human-readable structure.

## Procedure

1. Read `index.md`. Build a set of pages it references.
2. List `wiki/**/*.md`. For each page, classify: in-index, orphan, stub, suspect-duplicate, stale, weird.
3. For **safe deletes** (orphan + stub, broken weird files): delete and update `index.md`.
4. For **merges** and **non-trivial deletes**: write a short report to `outbox/wiki-prune-<YYYY-MM-DD>.md` listing the candidates with one-line rationale. The outbox file gets delivered to chat at end-of-turn.
5. After any actual change, re-sort `index.md` and append one terse line to `log.md` tagged `[prune]`.

## Output conventions

- Brand voice: no em dashes in user-facing content. Use `,`, `;`, or `-`.
- Dates: ISO 8601.
- Include counts in the log line, e.g. `2026-05-25 09:00 — pruned 7 orphans, 3 stubs; flagged 4 candidates [prune]`.

## When NOT to act autonomously

- Don't merge pages where the call is judgement-heavy (different vendors, different revisions of the same part). Surface for review.
- Don't touch `data/CLAUDE.md` or `data/skills/`.
- Don't delete the last remaining page on an active subject just to clean up.
```

- [ ] **Step 3: Commit**

```bash
git add data/CLAUDE.md data/skills/prune-wiki.md
git commit -m "docs(persona): rewrite for life-agent shape

Drop per-topic framing. cwd is data/, one shared wiki, log, outbox."
```

---

## Task 10: Update repo-level docs + gitignore

**Files:**
- Rewrite: `README.md`
- Rewrite: `CLAUDE.md` (top-level)
- Modify: `.gitignore`

- [ ] **Step 1: Rewrite `CLAUDE.md`**

```markdown
# icarus — codebase guide

Developer-facing README for the codebase, distinct from `data/CLAUDE.md` (the persona the running bot reads).

## What this is

A Telegram-driven personal life agent. A single operator DMs the bot; the bot spawns the `claude` CLI per turn with `cwd = data/`. One shared wiki, one log, one Claude session — like a Claude.ai Project, driven from inside Telegram.

The operator is gated by `OPERATOR_USER_ID` (a Telegram user id). Anyone else who finds the bot is ignored.

## Layout

```
data/
  CLAUDE.md           ← shared base persona (tracked)
  index.md            ← wiki catalog (gitignored)
  log.md              ← append-only activity log (gitignored)
  wiki/               ← markdown notes (gitignored)
  outbox/             ← files to deliver after a turn (gitignored)
  skills/<name>.md    ← global skill recipes (tracked)
state/
  messages.db         ← SQLite: messages + single-row 'life' sessions table
src/
  index.ts            ← orchestrator (bot ↔ agent), single 'life' mutex
  telegram.ts         ← grammY bot, DM-only, operator gating
  agent-runner.ts     ← spawns the claude CLI, streams events
  admin-commands.ts   ← /whoami, /ping, /help
  db.ts               ← SQLite: messages + sessions
  mutex.ts            ← tiny async lock
  config.ts           ← env + path constants (DATA_DIR, DB_PATH, OPERATOR_USER_ID)
  memory/
    scaffold.ts       ← ensureDataLayout()
    bootstrap.ts      ← prompt prefix (<wiki_index>, <recent_activity>, <skills>)
    log.ts            ← activity log
    outbox.ts         ← file delivery
scripts/
  weekly-prune.ts     ← runs the prune-wiki skill against data/wiki/
systemd/
  icarus.service
  icarus-prune.service
  icarus-prune.timer
```

## Running

```bash
npm install
cp .env.example .env  # fill in TELEGRAM_BOT_TOKEN; leave OPERATOR_USER_ID empty to bootstrap
npm run dev           # tsx hot reload
# or
npm run build && npm run start
```

In Telegram, DM the bot once. It replies with your user id; paste it into `OPERATOR_USER_ID` in `.env` and restart.

Tests + typecheck:

```bash
npm run typecheck
npm test
```

## Conventions

- Tracked under `data/`: `CLAUDE.md` and `skills/*.md`. Everything else under `data/` is gitignored — per-deployment content.
- SQLite db lives in `state/`, separate from the wiki.
- One Claude session, keyed `'life'`. The weekly-prune script reuses it.
- Slash commands handled by the bot: `/whoami`, `/ping`, `/help`. Anything else is forwarded verbatim to the claude subprocess.
```

- [ ] **Step 2: Rewrite `README.md`**

```markdown
<h1 align="center">icarus</h1>

<p align="center">
  A personal life agent driven from Telegram DMs. One operator, one shared wiki, one Claude session — like a Claude.ai Project that lives in the chat you're already in.
</p>

<p align="center">
  <a href="#quick-start">quick start</a>&nbsp; • &nbsp;
  <a href="#philosophy">philosophy</a>&nbsp; • &nbsp;
  <a href="#architecture">architecture</a>&nbsp; • &nbsp;
  <a href="#faq">faq</a>
  &nbsp; • &nbsp;
  <img src="https://img.shields.io/badge/node-%E2%89%A520-blue" alt="Node 20+">
  &nbsp;
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT">
  &nbsp;
  <img src="https://img.shields.io/badge/built%20on-Claude%20Code-orange" alt="Built on Claude Code">
</p>

---

## Why I built icarus

Claude.ai Projects are the right shape for long-running knowledge work — pin some files, chat about them, watch context compound. But they live behind a browser tab, and most of my actual conversations don't.

Telegram does. I wanted a single agent that knew everything I'd told it — projects, people, decisions, plans — and was always one DM away. icarus is that. The bot spawns the local `claude` CLI per turn with `cwd` set to a folder of markdown. You inherit Claude Code's full toolset (Bash, file edits, MCP servers, skills) and your existing CLI auth.

The whole thing is around 1,000 lines of TypeScript. Read it in an afternoon, fork it, change anything.

## Quick start

**You'll need:** Node 20+, the [`claude` CLI](https://claude.com/claude-code) installed and logged in, and a Telegram account.

```bash
git clone https://github.com/jeonwonje/icarus.git
cd icarus
npm install
cp .env.example .env       # fill in TELEGRAM_BOT_TOKEN
npm run dev
```

Then in Telegram:

1. Message [@BotFather](https://t.me/BotFather), `/newbot`, paste the token into `.env`.
2. DM your new bot. It will reply with your `user_id` and instructions.
3. Paste that id into `OPERATOR_USER_ID` in `.env`, restart.
4. DM the bot. Anyone else who finds the bot is silently ignored.

<details>
<summary><strong>Run as a user service (systemd)</strong></summary>

```bash
mkdir -p ~/.config/systemd/user
cp systemd/icarus.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now icarus
journalctl --user -u icarus -f
```

There's also a weekly prune timer (`systemd/icarus-prune.timer`) that runs the `prune-wiki` skill over `data/wiki/` — see `data/skills/prune-wiki.md`.
</details>

## Philosophy

**One operator, one wiki, one session.** Everything you tell the agent lives in `data/`. There's no per-topic or per-conversation split — the point is a single agent that remembers everything.

**Use the real `claude` CLI.** icarus doesn't reimplement an agent loop. It spawns `claude --resume <session>` per turn with `cwd=data/`. You inherit Claude Code's full toolset, every model release, your existing auth, and any MCP servers or skills you already have configured.

**Memory lives on disk, not in a vector DB.** A folder of short markdown pages: `index.md` is a one-line catalog, `log.md` is a tail of recent activity, and `wiki/` holds the notes. The agent reads `index.md` and the log tail at the top of every turn, then greps for whatever it needs. You can `cat` your own memory.

**Skills are markdown.** A skill is a single file at `data/skills/<name>.md`. The H1 becomes its title and shows up in every prompt's `<skills>` block; the rest is the recipe. You can add, edit, and delete skills by talking to the bot.

**Boring infrastructure.** SQLite for messages and the session id. A single async mutex. grammY for the Telegram side. No queues, no Redis, no orchestrator.

## What it supports

- **Single-operator DM gate** — only the user id in `OPERATOR_USER_ID` can talk to the bot.
- **Outbox file delivery** — drop a file into `data/outbox/` during a turn and it's sent back to the chat at end-of-turn, then deleted.
- **Slash command pass-through** — `/whoami`, `/ping`, `/help` are handled by the bot. Anything else (`/compact`, `/model`, `/clear`, `/init`, …) is forwarded verbatim to the `claude` subprocess.
- **Weekly prune** — a systemd timer that runs the `prune-wiki` skill to compact stale notes.
- **Audit trail** — every inbound and outbound message is persisted in `state/messages.db`.

## Usage

Once you're set up, DM the bot:

```
The new EV charger spec landed — 11 kW, three-phase, OCPP 1.6.
Note that and link it to the Acme deployment plan.

What did we decide about the Q3 commission split?

Compile a one-page summary of everything we know about Customer X
and put it in the outbox.
```

The agent will write or update pages under `wiki/`, refresh `index.md`, append a line to `log.md`, and (if you asked) drop a file in `outbox/` for delivery.

## Customizing

Two layers:

| Layer | File | Scope |
|-------|------|-------|
| Persona | `data/CLAUDE.md` | Loaded on every turn. Edit to change voice, profile, defaults. |
| Skills | `data/skills/<name>.md` | Recipes listed in every prompt's `<skills>` block. |

You can manage skills in chat ("add a skill called X to do Y", "remove the X skill") — they're plain file ops.

## Architecture

```
Telegram DM ──► grammY router ──► single 'life' mutex
                                       │
                                       ▼
                       spawn `claude --resume <sid>`
                                cwd = data/
                                       │
                                       ▼
                  agent reads/writes inside data/
                                       │
                                       ▼
             outbox/ delivered back to DM, then cleared
```

One Claude session, keyed `'life'`. A single mutex serializes turns. Messages and the session id persist in `state/messages.db` (SQLite, separate from the wiki).

**Key files:**

- `src/index.ts` — orchestrator wiring bot ↔ agent
- `src/telegram.ts` — grammY bot, DM-only, operator gating
- `src/agent-runner.ts` — spawns `claude`, streams events
- `src/admin-commands.ts` — `/whoami`, `/ping`, `/help`
- `src/db.ts` — SQLite (messages, sessions)
- `src/mutex.ts` — tiny async lock
- `src/memory/scaffold.ts` — `data/` skeleton
- `src/memory/bootstrap.ts` — assembles the `<wiki_index>` / `<recent_activity>` / `<skills>` prompt prefix
- `src/memory/log.ts` — activity log
- `src/memory/outbox.ts` — file delivery
- `scripts/weekly-prune.ts` — prune CLI

**On disk:**

```
data/
  CLAUDE.md                 ← persona (tracked)
  skills/<name>.md          ← global skill recipes (tracked)
  index.md                  ← catalog of pages in wiki/ (gitignored)
  log.md                    ← append-only activity log (gitignored)
  wiki/                     ← markdown notes (gitignored)
  outbox/                   ← files queued for delivery (gitignored)
state/
  messages.db               ← SQLite: messages + session id
```

## Tests

```bash
npm run typecheck
npm test
```

## FAQ

**Do I need a Claude API key?**

No. icarus shells out to the `claude` CLI you've already installed and logged into. Whatever subscription or API mode that CLI uses is what icarus uses.

**Why Telegram?**

The bot API is mature, grammY is excellent, and a DM is the lowest-friction way to talk to an agent from a phone, a desktop, and a watch — without building a UI.

**Can I run this for multiple users?**

Not in one process — `OPERATOR_USER_ID` is single-valued. Run multiple instances with separate `data/` and `state/` directories if you need to.

**How is this different from the official Claude.ai Telegram integrations?**

It isn't an integration — it's a self-hosted bot wrapping the local `claude` CLI. You own the data on disk, the agent runs with whatever tools and MCP servers your CLI has configured, and there's no third-party service in the loop besides Telegram itself.

**How big can the wiki get before it stops fitting?**

Only `index.md` and the tail of `log.md` are loaded every turn — actual pages are read on demand. The weekly `prune-wiki` skill exists to keep `index.md` and individual pages tight. In practice, hundreds of pages still work as long as `index.md` stays small.

## Contributing

Issues and PRs welcome. The codebase is small on purpose; please keep changes focused and avoid pulling in heavy dependencies. Run `npm run typecheck && npm test` before opening a PR.

## License

[MIT](LICENSE)
```

- [ ] **Step 3: Rewrite `.gitignore`**

```gitignore
node_modules/
dist/

# Per-instance state (sqlite db, runtime artifacts)
state/
logs/

# Mutable wiki/log/outbox content — only the persona and skills are tracked.
data/wiki/
data/outbox/
data/index.md
data/log.md

.env

*.db
*.db-journal
*.db-wal
*.db-shm

.DS_Store
.idea/
.vscode/
.tmp-*
```

- [ ] **Step 4: Commit**

```bash
git add README.md CLAUDE.md .gitignore
git commit -m "docs: rewrite README + CLAUDE.md + gitignore for life agent"
```

---

## Task 11: Verify everything

**Files:** none modified — verification only.

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck`
Expected: PASS, no errors.

If there are errors, read them carefully — most likely a missed import or a name mismatch (e.g., a call site still referencing `sendTextToTopic`). Fix in place; do not skip this step.

- [ ] **Step 2: Tests**

Run: `npm test`
Expected: All vitest suites pass. The suites are `db.test.ts`, `scaffold.test.ts`, `bootstrap.test.ts`, `outbox.test.ts`, `slug.test.ts`.

- [ ] **Step 3: Grep gates (acceptance criteria 2 from the spec)**

Run:

```bash
rg -n 'threadJid|chat_jid|data/threads|ThreadMessage|sendTextToTopic|sendFileToTopic|cli:weekly-prune' src scripts test
```

Expected: no matches.

Then run:

```bash
rg -n 'TELEGRAM_CHAT_ID' src scripts test
```

Expected: no matches.

- [ ] **Step 4: Sanity check on the build**

Run: `npm run build`
Expected: succeeds, produces `dist/`.

- [ ] **Step 5: If everything is clean, commit (otherwise fix and re-verify)**

If the previous steps required any fixes:

```bash
git add -A
git commit -m "chore: post-refactor cleanup to pass typecheck + tests"
```

If nothing needed fixing, do not create an empty commit — proceed.

- [ ] **Step 6: Push**

```bash
git push
```

---

## Acceptance summary

A successful run leaves the branch in this state:

- `npm run typecheck` and `npm test` clean.
- The grep gates above produce zero matches.
- `data/threads/` and `src/memory/threads.ts` do not exist.
- `OPERATOR_USER_ID` gates the Telegram side; `TELEGRAM_CHAT_ID` is gone.
- One Claude session keyed `'life'` in `sessions`; messages table has no `chat_jid` / `thread_id` columns.
- `data/CLAUDE.md` and `data/skills/prune-wiki.md` describe the single-wiki life-agent.
- `README.md` and top-level `CLAUDE.md` describe the new architecture.
