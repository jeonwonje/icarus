# Telegram Project Synthesis (Phase 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Propose selected-chat → existing-wiki-project mappings, require owner approve/reject, then write locator-style wiki briefs and one `MEMORY.md` pointer line per confirmed project.

**Architecture:** New migration + `TelegramProjectStore` for proposals/mappings. Deterministic `ProposalEngine` matches chat title/username tokens to wiki projects from `wiki/index.md`. On approve, `BriefWriter` writes `wiki/<project>/telegram-<chat-slug>.md` and upserts one memory line. Triggers: import-complete hook + system schedule `tg-project-sweep` (code path, not an agent turn). All archive reads go through `TelegramArchiveQuery`.

**Tech Stack:** TypeScript ESM, `node:sqlite` migrations, existing grammY keyboards, scheduler system rows, phase-2 `TelegramArchiveQuery`.

**Spec:** `docs/superpowers/specs/2026-07-26-telegram-project-synthesis-design.md`

**Branch / worktree:** Continue on `feature/tg-archive-retrieval` at `.worktrees/tg-archive-retrieval` (phase 2 already landed).

## Global Constraints

- `npm run typecheck` clean; `npm run selftest` prints `ok`; `npm test` green after every task.
- Queue stays single-lane. Sweep must not enqueue an agent turn (deterministic code in `fire()` special-case, like a lighter reflection path).
- Never write Desktop project folders — only `cfg.wikiDir/<project>/` and `cfg.memoryDir/MEMORY.md`.
- Never auto-create wiki projects; candidates come only from `wiki/index.md` project headings.
- No wiki/memory writes until explicit Approve. Reject is DB-only.
- At most one `pending` proposal per `peer_key`. Rejected chats are not re-proposed unless fingerprint changes.
- One `MEMORY.md` line per wiki project with ≥1 mapping: title + wiki path only.
- Brief path: `wiki/<project>/telegram-<chat-slug>.md`. Locator citations; no chat dumps.
- Archive reads only via `TelegramArchiveQuery` (deleted excluded by default).
- Append-only migrations in `src/db.ts` — never edit an applied migration string.
- Test files import `./env.js` first. Never commit `.env`, `state/`, `archive/`, or real wiki content.
- Commits: plain imperative, no attribution; identity `Jeon Wonje` / `jeonwonje04@gmail.com` if unset.
- Phase 2 retrieval behavior unchanged.

## File structure

| File | Responsibility |
|---|---|
| `src/db.ts` | New migration: `tg_project_proposals`, `tg_project_mappings` |
| `src/connectors/telegram/projectStore.ts` | CRUD for proposals/mappings |
| `src/connectors/telegram/wikiProjects.ts` | Parse wiki index → project list |
| `src/connectors/telegram/proposalEngine.ts` | Token match, fingerprint, enqueue, sweep |
| `src/connectors/telegram/briefWriter.ts` | Wiki brief + MEMORY.md pointer |
| `src/connectors/telegram/projectUi.ts` | Approve/reject keyboard render |
| `src/connectors/telegram/syncManager.ts` | Call proposal hook after import complete |
| `src/connectors/telegram/runtime.ts` | Wire engine; expose approve/reject/sweep |
| `src/scheduler/scheduler.ts` + `src/config.ts` | System job `tg-project-sweep` |
| `src/telegram/bot.ts` | `tgmap:` callbacks |
| `tests/tg-project-*.test.ts` | Unit/integration tests |

---

### Task 1: Schema + project store

**Files:**
- Modify: `src/db.ts` (append migration)
- Create: `src/connectors/telegram/projectStore.ts`
- Test: `tests/tg-project-store.test.ts`

**Interfaces:**
- Produces: `TelegramProjectStore` with propose/list/approve/reject/mapping helpers
- Consumes: `DatabaseSync`, `migrateDb`

- [ ] **Step 1: Write failing test**

```ts
import './env.js';

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { TelegramArchiveStore } from '../src/connectors/telegram/archiveStore.js';
import { TelegramProjectStore } from '../src/connectors/telegram/projectStore.js';
import { migrateDb } from '../src/db.js';

const fresh = () => {
  const db = new DatabaseSync(':memory:');
  migrateDb(db);
  const archive = new TelegramArchiveStore(db);
  archive.upsertDialog({ peerKey: 'group:1', kind: 'group', title: 'Morian Labs', selected: true });
  return { db, store: new TelegramProjectStore(db) };
};

test('enqueueProposal is idempotent for pending and unique per peer', () => {
  const { store } = fresh();
  const a = store.enqueueProposal({
    peerKey: 'group:1',
    wikiProject: 'morianlabs',
    evidence: 'title token morian',
    score: 2,
    fingerprint: 'fp1',
  });
  const b = store.enqueueProposal({
    peerKey: 'group:1',
    wikiProject: 'morianlabs',
    evidence: 'title token morian',
    score: 2,
    fingerprint: 'fp1',
  });
  assert.equal(a.id, b.id);
  assert.equal(store.listProposals('pending').length, 1);
});

test('reject then enqueue same fingerprint returns null; new fingerprint enqueues', () => {
  const { store } = fresh();
  const p = store.enqueueProposal({
    peerKey: 'group:1',
    wikiProject: 'morianlabs',
    evidence: 'x',
    score: 1,
    fingerprint: 'fp1',
  });
  store.rejectProposal(p!.id);
  assert.equal(
    store.enqueueProposal({
      peerKey: 'group:1',
      wikiProject: 'morianlabs',
      evidence: 'x',
      score: 1,
      fingerprint: 'fp1',
    }),
    null,
  );
  const again = store.enqueueProposal({
    peerKey: 'group:1',
    wikiProject: 'morianlabs',
    evidence: 'y',
    score: 1,
    fingerprint: 'fp2',
  });
  assert.ok(again);
  assert.equal(again.state, 'pending');
});

test('approveProposal writes mapping and marks proposal approved', () => {
  const { store } = fresh();
  const p = store.enqueueProposal({
    peerKey: 'group:1',
    wikiProject: 'morianlabs',
    evidence: 'x',
    score: 1,
    fingerprint: 'fp1',
  });
  store.approveProposal(p!.id, 'morianlabs/telegram-morian-labs.md');
  assert.equal(store.getMapping('group:1')?.wikiProject, 'morianlabs');
  assert.equal(store.getProposal(p!.id)?.state, 'approved');
});
```

- [ ] **Step 2: Run — expect FAIL** (missing module / tables)

Run: `npm test -- tests/tg-project-store.test.ts`

- [ ] **Step 3: Append migration in `src/db.ts`**

Append to `MIGRATIONS` (new string — do not edit prior ones):

```ts
  `
  CREATE TABLE tg_project_proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    peer_key TEXT NOT NULL REFERENCES tg_chats(peer_key) ON DELETE CASCADE,
    wiki_project TEXT NOT NULL,
    evidence TEXT NOT NULL,
    score REAL NOT NULL,
    fingerprint TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','approved','rejected')),
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    UNIQUE(peer_key, fingerprint)
  );
  CREATE INDEX idx_tg_project_proposals_pending
    ON tg_project_proposals(state, peer_key);
  CREATE TABLE tg_project_mappings (
    peer_key TEXT PRIMARY KEY REFERENCES tg_chats(peer_key) ON DELETE CASCADE,
    wiki_project TEXT NOT NULL,
    brief_path TEXT NOT NULL,
    approved_at TEXT NOT NULL,
    proposal_id INTEGER REFERENCES tg_project_proposals(id)
  );
  CREATE INDEX idx_tg_project_mappings_project ON tg_project_mappings(wiki_project);
  `,
```

- [ ] **Step 4: Implement `projectStore.ts`**

```ts
import type { DatabaseSync } from 'node:sqlite';
import { now } from '../../db.js';

export type ProposalState = 'pending' | 'approved' | 'rejected';

export interface ProjectProposal {
  id: number;
  peerKey: string;
  wikiProject: string;
  evidence: string;
  score: number;
  fingerprint: string;
  state: ProposalState;
  createdAt: string;
  resolvedAt?: string;
}

export interface ProjectMapping {
  peerKey: string;
  wikiProject: string;
  briefPath: string;
  approvedAt: string;
  proposalId?: number;
}

export class TelegramProjectStore {
  constructor(private readonly db: DatabaseSync) {}

  getMapping(peerKey: string): ProjectMapping | undefined { /* SELECT … */ }

  listMappingsForProject(wikiProject: string): ProjectMapping[] { /* … */ }

  hasMapping(peerKey: string): boolean {
    return this.getMapping(peerKey) !== undefined;
  }

  getProposal(id: number): ProjectProposal | undefined { /* … */ }

  getPendingForPeer(peerKey: string): ProjectProposal | undefined {
    /* state='pending' */
  }

  listProposals(state?: ProposalState): ProjectProposal[] { /* … */ }

  /**
   * Inserts pending proposal. Returns existing pending row if one exists.
   * Returns null if this fingerprint was already rejected (or approved) for the peer.
   */
  enqueueProposal(input: {
    peerKey: string;
    wikiProject: string;
    evidence: string;
    score: number;
    fingerprint: string;
  }): ProjectProposal | null {
    const existingPending = this.getPendingForPeer(input.peerKey);
    if (existingPending) return existingPending;
    const prior = this.db
      .prepare(
        `SELECT id,state FROM tg_project_proposals WHERE peer_key=? AND fingerprint=?`,
      )
      .get(input.peerKey, input.fingerprint) as unknown as
      | { id: number; state: string }
      | undefined;
    if (prior) return null;
    const ts = now();
    const result = this.db
      .prepare(
        `INSERT INTO tg_project_proposals(peer_key,wiki_project,evidence,score,fingerprint,state,created_at)
         VALUES(?,?,?,?,?,'pending',?)`,
      )
      .run(input.peerKey, input.wikiProject, input.evidence, input.score, input.fingerprint, ts);
    return this.getProposal(Number(result.lastInsertRowid))!;
  }

  rejectProposal(id: number): void {
    this.db
      .prepare(
        `UPDATE tg_project_proposals SET state='rejected', resolved_at=? WHERE id=? AND state='pending'`,
      )
      .run(now(), id);
  }

  approveProposal(id: number, briefPath: string): ProjectMapping {
    const proposal = this.getProposal(id);
    if (!proposal || proposal.state !== 'pending') throw new Error('proposal not pending');
    const ts = now();
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `UPDATE tg_project_proposals SET state='approved', resolved_at=? WHERE id=?`,
        )
        .run(ts, id);
      this.db
        .prepare(
          `INSERT INTO tg_project_mappings(peer_key,wiki_project,brief_path,approved_at,proposal_id)
           VALUES(?,?,?,?,?)
           ON CONFLICT(peer_key) DO UPDATE SET
             wiki_project=excluded.wiki_project,
             brief_path=excluded.brief_path,
             approved_at=excluded.approved_at,
             proposal_id=excluded.proposal_id`,
        )
        .run(proposal.peerKey, proposal.wikiProject, briefPath, ts, id);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return this.getMapping(proposal.peerKey)!;
  }
}
```

Map sqlite rows with `as unknown as T` like the rest of the codebase.

- [ ] **Step 5: Run tests — expect PASS**

- [ ] **Step 6: Commit**

```bash
git add src/db.ts src/connectors/telegram/projectStore.ts tests/tg-project-store.test.ts
git commit -m "Add Telegram project mapping and proposal storage"
```

---

### Task 2: Wiki index parser + proposal engine

**Files:**
- Create: `src/connectors/telegram/wikiProjects.ts`
- Create: `src/connectors/telegram/proposalEngine.ts`
- Test: `tests/tg-proposal-engine.test.ts`

**Interfaces:**
- Consumes: `TelegramProjectStore`, chat title/username, optional `TelegramArchiveQuery`
- Produces: `listWikiProjects`, `matchChatToProjects`, `ProposalEngine.considerChat` / `sweep`

- [ ] **Step 1: Failing tests**

```ts
import './env.js';

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { TelegramArchiveStore } from '../src/connectors/telegram/archiveStore.js';
import { TelegramProjectStore } from '../src/connectors/telegram/projectStore.js';
import { ProposalEngine } from '../src/connectors/telegram/proposalEngine.js';
import { listWikiProjects, tokenize } from '../src/connectors/telegram/wikiProjects.js';
import { migrateDb } from '../src/db.js';

test('listWikiProjects reads ### [slug](slug/index.md) headings only', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wiki-'));
  writeFileSync(
    path.join(root, 'index.md'),
    `# Index\n\n### [morianlabs](morianlabs/index.md)\nDuck robot\n\n### [sodion-atlas](sodion-atlas/index.md)\nBattery\n\n## [me](me/index.md)\nPerson\n`,
  );
  const projects = listWikiProjects(root);
  assert.deepEqual(
    projects.map((p) => p.slug),
    ['morianlabs', 'sodion-atlas'],
  );
});

test('considerChat enqueues when title overlaps project slug', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wiki-'));
  writeFileSync(
    path.join(root, 'index.md'),
    `### [morianlabs](morianlabs/index.md)\nMorian Duck\n`,
  );
  const db = new DatabaseSync(':memory:');
  migrateDb(db);
  const archive = new TelegramArchiveStore(db);
  archive.upsertDialog({
    peerKey: 'group:1',
    kind: 'group',
    title: 'Morian Labs build chat',
    selected: true,
  });
  const projects = new TelegramProjectStore(db);
  const engine = new ProposalEngine({
    archive,
    projects,
    wikiDir: root,
  });
  const created = engine.considerChat('group:1');
  assert.ok(created);
  assert.equal(created.wikiProject, 'morianlabs');
  assert.equal(engine.considerChat('group:1'), null); // pending exists
});

test('sweep skips rejected fingerprint', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wiki-'));
  writeFileSync(
    path.join(root, 'index.md'),
    `### [morianlabs](morianlabs/index.md)\nMorian\n`,
  );
  const db = new DatabaseSync(':memory:');
  migrateDb(db);
  const archive = new TelegramArchiveStore(db);
  archive.upsertDialog({
    peerKey: 'group:1',
    kind: 'group',
    title: 'Morian Labs',
    selected: true,
  });
  const projects = new TelegramProjectStore(db);
  const engine = new ProposalEngine({ archive, projects, wikiDir: root });
  const p = engine.considerChat('group:1');
  projects.rejectProposal(p!.id);
  assert.equal(engine.sweep().length, 0);
});
```

- [ ] **Step 2: Implement `wikiProjects.ts`**

```ts
import { readFileSync } from 'node:fs';
import path from 'node:path';

export interface WikiProject {
  slug: string;
  title: string; // first meaningful line after heading, else slug
}

const HEADING = /^###\s+\[([a-z0-9-]+)\]\(\1\/index\.md\)\s*$/i;

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 4); // distinctive multi-character tokens
}

export function listWikiProjects(wikiDir: string): WikiProject[] {
  let index: string;
  try {
    index = readFileSync(path.join(wikiDir, 'index.md'), 'utf8');
  } catch {
    return [];
  }
  const lines = index.split(/\r?\n/);
  const out: WikiProject[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(HEADING);
    if (!m) continue;
    const slug = m[1].toLowerCase();
    let title = slug;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j].trim();
      if (!line) continue;
      if (line.startsWith('#')) break;
      title = line.replace(/\*\*/g, '').slice(0, 120);
      break;
    }
    out.push({ slug, title });
  }
  return out;
}
```

- [ ] **Step 3: Implement `proposalEngine.ts`**

Matching rules (v1):
- Build chat tokens from `title` + `username` via `tokenize`.
- For each wiki project, score = number of chat tokens that equal the slug, a slug segment (`slug.split('-')` length≥4), or a token from `tokenize(title)`.
- Require score ≥ 1 and at least one match against the **slug or a slug segment** (not title-only) so random title words don’t map.
- Pick highest score; tie → lexicographically first slug.
- Fingerprint: `sha256(`${wikiProject}:${sortedChatTokens.join(',')}`)`.hex slice 16.
- `considerChat`: skip if not selected, already mapped, or wiki empty; else enqueue best match.
- `sweep`: for each selected unmapped chat, `considerChat`; return newly created proposals.

Optional reinforce: if `query` is provided, `search({ query: slug, peerKey, limit: 3 })` — if zero hits, do **not** disqualify (title match alone is enough); hits may append to evidence string only.

- [ ] **Step 4: Tests PASS + typecheck**

- [ ] **Step 5: Commit**

```bash
git add src/connectors/telegram/wikiProjects.ts src/connectors/telegram/proposalEngine.ts tests/tg-proposal-engine.test.ts
git commit -m "Match Telegram chats to wiki projects for mapping proposals"
```

---

### Task 3: Brief writer + memory pointer + approve path

**Files:**
- Create: `src/connectors/telegram/briefWriter.ts`
- Create: `src/connectors/telegram/projectUi.ts`
- Modify: `src/connectors/telegram/projectStore.ts` only if needed
- Test: `tests/tg-brief-writer.test.ts`

**Interfaces:**
- Consumes: `TelegramArchiveQuery`, `TelegramProjectStore`, `cfg.wikiDir` / memory dir (injected paths)
- Produces: `writeBriefAndMemory`, `renderProjectProposal`, `chatSlug`

- [ ] **Step 1: Failing tests**

```ts
import './env.js';

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { TelegramArchiveQuery } from '../src/connectors/telegram/archiveQuery.js';
import { TelegramArchiveStore } from '../src/connectors/telegram/archiveStore.js';
import {
  applyApproval,
  chatSlug,
  upsertMemoryPointer,
} from '../src/connectors/telegram/briefWriter.js';
import { TelegramProjectStore } from '../src/connectors/telegram/projectStore.js';
import { migrateDb } from '../src/db.js';
import type { TelegramMessage } from '../src/connectors/telegram/types.js';

const msg = (id: number, text: string): TelegramMessage => ({
  peerKey: 'group:1',
  messageId: id,
  senderName: 'Dev',
  sentAt: '2026-01-01T00:00:00.000Z',
  text,
  entitiesJson: '[]',
  reactionsJson: '[]',
  media: [],
  links: [],
});

test('chatSlug kebab-cases titles', () => {
  assert.equal(chatSlug('Morian Labs build chat'), 'morian-labs-build-chat');
});

test('applyApproval writes brief under wiki project and one memory line', () => {
  const wiki = mkdtempSync(path.join(tmpdir(), 'wiki-'));
  const memoryDir = path.join(wiki, 'memory');
  mkdirSync(path.join(wiki, 'morianlabs'), { recursive: true });
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(path.join(memoryDir, 'MEMORY.md'), '# Memory index\n\n');
  const db = new DatabaseSync(':memory:');
  migrateDb(db);
  const archive = new TelegramArchiveStore(db);
  archive.upsertDialog({
    peerKey: 'group:1',
    kind: 'group',
    title: 'Morian Labs',
    username: 'morianchat',
    selected: true,
  });
  archive.applyMessages(
    [msg(10, 'We decided the duck chassis uses aluminum plates next week')],
    'backfill',
  );
  const projects = new TelegramProjectStore(db);
  const proposal = projects.enqueueProposal({
    peerKey: 'group:1',
    wikiProject: 'morianlabs',
    evidence: 'title',
    score: 1,
    fingerprint: 'fp',
  })!;
  const query = new TelegramArchiveQuery(archive);
  const result = applyApproval({
    proposalId: proposal.id,
    projects,
    query,
    archive,
    wikiDir: wiki,
    memoryDir,
  });
  assert.equal(result.briefPath, 'morianlabs/telegram-morian-labs.md');
  const brief = readFileSync(path.join(wiki, result.briefPath), 'utf8');
  assert.match(brief, /telegram-/);
  assert.match(brief, /chassis|aluminum|duck/i);
  assert.match(brief, /t\.me|group:1#10/);
  assert.doesNotMatch(brief, /lol|haha/); // low-signal not required present
  const memory = readFileSync(path.join(memoryDir, 'MEMORY.md'), 'utf8');
  assert.match(memory, /morianlabs/);
  assert.equal([...memory.matchAll(/morianlabs/g)].length, 1);
  // re-approve / upsert does not duplicate
  upsertMemoryPointer(memoryDir, 'morianlabs', 'Morian Duck');
  const memory2 = readFileSync(path.join(memoryDir, 'MEMORY.md'), 'utf8');
  assert.equal([...memory2.matchAll(/^- /gm)].filter((m) => memory2.includes('morianlabs')).length >= 1, true);
  assert.ok((memory2.match(/wiki\/morianlabs/g) ?? []).length <= 1);
});

test('reject leaves wiki and memory untouched', () => {
  const wiki = mkdtempSync(path.join(tmpdir(), 'wiki-'));
  const memoryDir = path.join(wiki, 'memory');
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(path.join(memoryDir, 'MEMORY.md'), '# Memory index\n');
  const before = readFileSync(path.join(memoryDir, 'MEMORY.md'), 'utf8');
  const db = new DatabaseSync(':memory:');
  migrateDb(db);
  const archive = new TelegramArchiveStore(db);
  archive.upsertDialog({ peerKey: 'group:1', kind: 'group', title: 'Morian', selected: true });
  const projects = new TelegramProjectStore(db);
  const p = projects.enqueueProposal({
    peerKey: 'group:1',
    wikiProject: 'morianlabs',
    evidence: 'x',
    score: 1,
    fingerprint: 'fp',
  })!;
  projects.rejectProposal(p.id);
  assert.equal(readFileSync(path.join(memoryDir, 'MEMORY.md'), 'utf8'), before);
  assert.equal(projects.getMapping('group:1'), undefined);
});
```

- [ ] **Step 2: Implement brief writer**

`chatSlug(title)`: lowercase, replace non-alnum with `-`, collapse, trim `-`, max 60 chars.

`isLowSignal(text)`: true if after trim length < 24, or fewer than 3 alphanumeric tokens of length≥3, or mostly emoji/punctuation.

`applyApproval`:
1. Load pending proposal + chat row (title).
2. `briefRel = `${wikiProject}/telegram-${chatSlug(title)}.md``.
3. Search archive: `query.search({ query: wikiProject.replace(/-/g,' '), peerKey, limit: 8 })`; filter `!isLowSignal(snippet)`; take up to 5.
4. If no hits, use `query.window` on newest message id if any — still filter low-signal; if still empty, write a stub brief that states mapping only + “no high-signal samples yet” with chat identity (still a valid locator page).
5. Write markdown with frontmatter-ish header:
   ```md
   # Telegram brief — <chat title>

   Mapped from selected Telegram chat `<peerKey>`. Claims cite archive messages (retrievable).

   ## Notes
   - <claim clipped> — <sender>, <sentAt>, <deepLink or peer#id>
   ```
6. `projects.approveProposal(id, briefRel)` **after** successful write (if mapping insert fails, leave file — report concern; prefer write file then approve in try/catch and delete file on failure if easy).
7. `upsertMemoryPointer(memoryDir, wikiProject, displayTitle)` — ensure section or single line:
   `- **<title>** — Telegram project brief: wiki/<project>/`
   Replace existing line containing `wiki/<project>/` rather than appending duplicates.

Path safety: `path.join(wikiDir, wikiProject, filename)` must resolve with `path.resolve` still starting with `path.resolve(wikiDir)` — throw if not.

- [ ] **Step 3: `projectUi.ts`**

```ts
export function renderProjectProposal(input: {
  id: number;
  chatTitle: string;
  wikiProject: string;
  evidence: string;
}): { text: string; keyboard: InlineKeyboard } {
  // Approve / Reject buttons: tgmap:ok:<id> / tgmap:no:<id>
}
```

- [ ] **Step 4: Tests PASS**

- [ ] **Step 5: Commit**

```bash
git add src/connectors/telegram/briefWriter.ts src/connectors/telegram/projectUi.ts tests/tg-brief-writer.test.ts
git commit -m "Write wiki briefs and memory pointers on mapping approval"
```

---

### Task 4: Wire triggers, runtime, bot, scheduler

**Files:**
- Modify: `src/connectors/telegram/syncManager.ts` (hook after `announceCompletion`)
- Modify: `src/connectors/telegram/runtime.ts`
- Modify: `src/telegram/bot.ts`
- Modify: `src/config.ts` (`PROJECT_SWEEP_JOB = 'tg-project-sweep'`)
- Modify: `src/scheduler/scheduler.ts` (seed + `fire` special-case)
- Test: `tests/tg-project-wiring.test.ts` (engine consider after simulated complete; sweep job name constant)

**Interfaces:**
- Consumes: Tasks 1–3
- Produces: live approve/reject + import/sweep triggers

- [ ] **Step 1: SyncManager hook**

Extend deps with optional `onImportComplete?: (peerKey: string) => Promise<void>`.
After successful `announceCompletion(peerKey)`, `await this.deps.onImportComplete?.(peerKey)`.

Runtime wires:
```ts
onImportComplete: async (peerKey) => {
  const proposal = engine.considerChat(peerKey);
  if (!proposal) return;
  const chat = store.getChat(peerKey);
  const rendered = renderProjectProposal({...});
  await notifyKeyboard?.(rendered); // or sendOwnerKeyboard
}
```

If only `notify(text)` exists today, extend runtime notify path: use `sendOwnerKeyboard` from telegram/send for proposals (import `sendOwnerKeyboard` in runtime like proposals.ts). Keep import-complete text announce as-is; send proposal as a **separate** DM with buttons.

- [ ] **Step 2: Bot callbacks**

In `handleCallback`, handle `tgmap:ok:` / `tgmap:no:`:
- ok → `runtime.approveMapping(id)` → edit message to “approved · brief wiki/…”
- no → `runtime.rejectMapping(id)` → edit to “rejected · left unmapped”

- [ ] **Step 3: Scheduler**

`config.ts`: `export const PROJECT_SWEEP_JOB = 'tg-project-sweep';`

`seedSystemRows`: insert weekly cron e.g. `0 9 * * 1` (Monday 09:00 local), prompt placeholder `'(code — proposalEngine.sweep)'`.

In `fire()`:
```ts
if (row.name === PROJECT_SWEEP_JOB) {
  const { runTelegramProjectSweep } = await import('../connectors/telegram/projectSweep.js');
  // or call runtime export
  const n = await runTelegramProjectSweep();
  db.prepare(`UPDATE schedules SET last_status=? WHERE id=?`).run(`ok:${n} proposals`, id);
  return; // do not enqueue agent
}
```

Implement `runTelegramProjectSweep` in `proposalEngine.ts` or thin `projectSweep.ts` that uses `telegramRuntime()`; if runtime null, no-op return 0; else sweep and DM each new proposal with buttons.

- [ ] **Step 4: Test wiring lightly**

Unit-test that `ProposalEngine.sweep` is invoked from a exported `runTelegramProjectSweep` with a fake runtime/store (injectable), and that `PROJECT_SWEEP_JOB` is seeded (call `seedSystemRows` against memory db — may need to openDb pattern or insert via scheduler helpers). If scheduler tests are awkward, assert constant + `fire` branch with a mocked enqueue that must **not** be called for sweep — prefer extracting `handleProjectSweepFire(): number` pure-ish function.

Minimum: test `runTelegramProjectSweep` with injected deps creates DMs count === new proposals.

- [ ] **Step 5: typecheck + full test**

- [ ] **Step 6: Commit**

```bash
git add src/connectors/telegram/syncManager.ts src/connectors/telegram/runtime.ts src/telegram/bot.ts src/config.ts src/scheduler/scheduler.ts src/connectors/telegram/projectSweep.ts tests/tg-project-wiring.test.ts
git commit -m "Wire mapping proposals to import completion and weekly sweep"
```

---

### Task 5: Persona note + spec status

**Files:**
- Modify: `persona/persona.md` (short phase-3 note under Telegram archive)
- Modify: `docs/superpowers/specs/2026-07-26-telegram-project-synthesis-design.md` status → `approved for implementation` / keep; optionally `implemented` only after manual acceptance — set `approved for implementation` if not already
- Modify: `README.md` one line: mapping proposals arrive as DMs after import / weekly sweep

- [ ] **Step 1: Persona**

```markdown
- Mapping proposals (chat → wiki project) arrive as DMs with Approve/Reject. Never write
  wiki briefs or MEMORY.md Telegram pointers until Jeon approves. Do not invent mappings.
```

Separate persona commit.

- [ ] **Step 2: README + spec status**

- [ ] **Step 3: `npm run typecheck && npm test && npm run selftest`**

- [ ] **Step 4: Commits**

```bash
git add persona/persona.md
git commit -m "persona: wait for approval before Telegram project wiki writes"

git add README.md docs/superpowers/specs/2026-07-26-telegram-project-synthesis-design.md
git commit -m "Document Telegram project mapping proposals"
```

---

## Self-review (plan author)

1. Spec coverage: proposals, approve/reject, briefs, memory line, import+sweep triggers, wiki-only writes, fingerprint anti-spam, ArchiveQuery reuse — tasked.
2. No TBD placeholders.
3. Sweep is code-path not agent — matches “deterministic cheap matching”.
4. Phase 2 API unchanged.

## Execution

Continue SDD on the existing worktree/branch. After Task 5 + whole-branch review, use finishing-a-development-branch (phase 2+3 together).
