# Project Raw Shelf Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On intentional ingest (DM + archive), runtime shelves bytes into `Desktop/<project>/raw/` with sha256 dedup, then deep-ingest uses that human-readable path.

**Architecture:** Shared `fileToRaw` helper + `raw_shelf` SQLite index. DM always uses a project picker; archive uses sticky mapping else picker. Blobs/inbox stay bulk stores. Wiki locators point at `raw/`.

**Tech Stack:** TypeScript ESM, `node:sqlite`, `node:test` via `tsx --test`, grammY callbacks, existing Telegram archive store/blobs.

## Global Constraints

- Shelf path: `Desktop/<project>/raw/<YYYY-MM-DD>_<sanitized-original>` only — no `Desktop/raw/`, no `wiki/.../raw/`
- Date prefix uses `cfg.tz` via `en-CA` calendar date
- Dedup: same `(project, sha256)` → reuse path; `-N` only when different bytes share a display name
- Bytes: `fs.linkSync` when same volume; else `copyFileSync`; never delete inbox or blob
- Owner-bot DM: always project picker (no sticky)
- Archive: sticky `tg_project_mappings` for `peerKey` else picker
- Runtime is the only writer into `<project>/raw/`; triage LLM does not write there
- Append-only DB migrations in `src/db.ts` (never edit applied migrations)
- No Co-Authored-By / Claude attribution in commits; do not push; do not update git config
- Work from repo root of the `project-raw-shelf` worktree; `npm run typecheck` and focused tests must stay clean

## File map

| File | Responsibility |
|---|---|
| `src/db.ts` | New migration: `raw_shelf` table |
| `src/rawShelf.ts` | `fileToRaw`, naming, hardlink/copy, project path checks |
| `src/rawShelfStore.ts` | SQLite CRUD for `raw_shelf` |
| `src/rawProjects.ts` | Wiki ∩ Desktop project slugs for picker |
| `src/telegram/ui.ts` | Project picker keyboard helpers |
| `src/telegram/bot.ts` | DM ingest → picker → fileToRaw → deep-ingest; archive ingest callbacks |
| `src/connectors/telegram/archiveUi.ts` | Ingest button on archive window when media done |
| `src/connectors/telegram/runtime.ts` | Expose helpers needed for archive ingest (mapping + blob path) |
| `persona/persona.md` (via default in `src/agent/persona.ts` if that's source) | Guidance: ingest uses raw path after shelf |
| `tests/raw-shelf.test.ts` | Unit tests for fileToRaw + store |

---

### Task 1: `raw_shelf` migration + store

**Files:**
- Modify: `src/db.ts` (append migration)
- Create: `src/rawShelfStore.ts`
- Test: `tests/raw-shelf.test.ts` (store section)

**Interfaces:**
- Produces:
  - `RawShelfStore` with:
    - `get(project: string, sha256: string): { project: string; sha256: string; relPath: string; bytes: number; createdAt: string } | undefined`
    - `upsert(row: { project: string; sha256: string; relPath: string; bytes: number; createdAt: string }): void`
    - `delete(project: string, sha256: string): void` (for miss repair optional)

- [ ] **Step 1: Write failing store test**

In `tests/raw-shelf.test.ts`:

```ts
import './env.js';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { migrateDb } from '../src/db.js';
import { RawShelfStore } from '../src/rawShelfStore.js';

test('raw_shelf store upserts and gets by project+sha', () => {
  const db = new DatabaseSync(':memory:');
  migrateDb(db);
  const store = new RawShelfStore(db);
  assert.equal(store.get('morianlabs', 'a'.repeat(64)), undefined);
  store.upsert({
    project: 'morianlabs',
    sha256: 'a'.repeat(64),
    relPath: '2026-07-26_quote.pdf',
    bytes: 12,
    createdAt: '2026-07-26T00:00:00.000Z',
  });
  const row = store.get('morianlabs', 'a'.repeat(64));
  assert.equal(row?.relPath, '2026-07-26_quote.pdf');
  assert.equal(row?.bytes, 12);
});
```

- [ ] **Step 2: Run test — expect fail (missing module / table)**

Run: `npx tsx --test tests/raw-shelf.test.ts`
Expected: FAIL (cannot find module or no such table)

- [ ] **Step 3: Append migration + implement store**

Append to `MIGRATIONS` in `src/db.ts`:

```sql
CREATE TABLE raw_shelf (
  project TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK(length(sha256)=64),
  rel_path TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project, sha256)
);
CREATE INDEX idx_raw_shelf_project ON raw_shelf(project);
```

Implement `src/rawShelfStore.ts` with prepared statements matching the interface above. Use `as unknown as T` for sqlite rows per project convention.

- [ ] **Step 4: Run test — expect pass**

Run: `npx tsx --test tests/raw-shelf.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```powershell
git add src/db.ts src/rawShelfStore.ts tests/raw-shelf.test.ts
git commit -m @"
Add raw_shelf SQLite index for project file dedup.

"@
```

---

### Task 2: `fileToRaw` helper

**Files:**
- Create: `src/rawShelf.ts`
- Create: `src/rawProjects.ts`
- Modify: `tests/raw-shelf.test.ts`

**Interfaces:**
- Consumes: `RawShelfStore`, `cfg.desktopDir`, `cfg.tz`
- Produces:
  - `listShelvableProjects(): string[]` — wiki index slugs that exist as dirs under `cfg.desktopDir`
  - `fileToRaw(input: { project: string; sourcePath: string; displayName: string; store: RawShelfStore; now?: Date }): { path: string; reused: boolean; hash: string }`
  - Throws `Error` with readable message when project folder missing, source missing, or slug empty

Behavior (locked):
1. Resolve `Desktop/<project>/` — must exist as directory
2. `mkdirSync(rawDir, { recursive: true })`
3. Hash source with sha256 of file bytes
4. If store has row and `existsSync(join(rawDir, relPath))` → return that absolute path, `reused: true`
5. If store has row but file missing → treat as miss (delete index row optional), continue to shelf
6. Sanitize `displayName` (strip path, replace `<>:"/\|?*` and control chars with `_`, max 120 basename)
7. Date prefix: `new Intl.DateTimeFormat('en-CA', { timeZone: cfg.tz, year:'numeric', month:'2-digit', day:'2-digit' }).format(now)`
8. Candidate `YYYY-MM-DD_<sanitized>`; if exists and hash differs, try `-2`, `-3`, … before extension
9. Same volume → `linkSync(source, dest)`; on failure or different volume → `copyFileSync`
10. `store.upsert`; return `{ path: dest, reused: false, hash }`

Same volume on Windows: compare drive letter of `path.resolve` sources (case-insensitive). On non-win32: compare `statSync().dev`.

- [ ] **Step 1: Write failing fileToRaw tests**

```ts
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, linkSync } from 'node:fs';
// ... use temp desktop root by injecting paths — prefer fileToRaw accepts optional roots for test:

// Export internals or pass deps:
// fileToRaw({ ..., desktopDir: tmpDesktop, tz: 'Asia/Singapore', store })
```

Tests required:
1. Copies/links into `<project>/raw/YYYY-MM-DD_name.ext` and indexes
2. Second call with identical bytes returns `reused: true` and same path (one file on disk)
3. Same display name different bytes gets `-2` before extension
4. Missing project dir throws
5. Missing source throws

Extend `fileToRaw` signature with optional `desktopDir?: string` and `tz?: string` for tests (default `cfg`).

- [ ] **Step 2: Run tests — expect fail**

Run: `npx tsx --test tests/raw-shelf.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `rawProjects.ts` + `rawShelf.ts`**

`listShelvableProjects`:
```ts
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { cfg } from './config.js';
import { listWikiProjects } from './connectors/telegram/wikiProjects.js';

export function listShelvableProjects(
  wikiDir = cfg.wikiDir,
  desktopDir = cfg.desktopDir,
): string[] {
  return listWikiProjects(wikiDir)
    .map((p) => p.slug)
    .filter((slug) => {
      const dir = path.join(desktopDir, slug);
      try {
        return existsSync(dir) && statSync(dir).isDirectory();
      } catch {
        return false;
      }
    });
}
```

Implement `fileToRaw` per behavior above.

- [ ] **Step 4: Run tests — expect pass**

Run: `npx tsx --test tests/raw-shelf.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```powershell
git add src/rawShelf.ts src/rawProjects.ts tests/raw-shelf.test.ts
git commit -m @"
Add fileToRaw shelving with content-hash dedup.

"@
```

---

### Task 3: DM ingest → picker → shelf → deep-ingest

**Files:**
- Modify: `src/telegram/ui.ts`
- Modify: `src/telegram/bot.ts`
- Modify: `src/agent/persona.ts` (DEFAULT_PERSONA Files section) — and `persona/persona.md` if that is the live file
- Test: extend `tests/raw-shelf.test.ts` with pure helpers if extracted; otherwise manual callback wiring covered by typecheck + a small unit test for keyboard payload encoding

**Interfaces:**
- Consumes: `fileToRaw`, `listShelvableProjects`, `RawShelfStore` on `db`, `refFor`/`refGet`
- Callback data:
  - `file:<pathRef>:ingest` → show project picker (do not ingest yet)
  - `fileproj:<pathRef>:<projectRef>` → fileToRaw then `submitOwnerText` deep-ingest on raw path

- [ ] **Step 1: Add picker keyboard helper**

In `src/telegram/ui.ts`:

```ts
export function fileProjectPickerKeyboard(savedPath: string, projects: string[]): InlineKeyboard {
  const pathRef = refFor(savedPath);
  const kb = new InlineKeyboard();
  if (projects.length === 0) {
    kb.text('no shelvable projects', 'noop');
    return kb;
  }
  for (const p of projects) {
    kb.text(`📁 ${p}`, `fileproj:${pathRef}:${refFor(p)}`).row();
  }
  kb.text('cancel', `file:${pathRef}:keep`);
  return kb;
}
```

Keep summarize/keep on the first keyboard; change ingest label if needed to stay `📥 ingest into wiki`.

- [ ] **Step 2: Wire bot callbacks**

Replace ingest branch so it edits message to “pick a project” with `fileProjectPickerKeyboard`.

Add `fileproj:` handler:
1. Resolve path + project from refs; expired if missing
2. `const store = new RawShelfStore(db)`
3. `fileToRaw({ project, sourcePath: savedPath, displayName: path.basename(savedPath), store })`
4. On success: edit message with shelved path (`reused` note if set); `submitOwnerText`  
   `Ingest this file into the wiki using the deep-ingest skill: ${rawPath}`  
   (optional second line: `It is already filed under Desktop/<project>/raw/.`)
5. On error: edit message with error text; do not submit turn

Import `db` from `../db.js`.

- [ ] **Step 3: Update persona Files section**

In live persona source (`persona/persona.md` if present, else DEFAULT in `src/agent/persona.ts`):

- After transport shelves on ingest, the path in the ingest prompt is under `Desktop\<project>\raw\` — deep-ingest that path; do not move it.
- Do not create `raw\` folders yourself; runtime owns filing.
- Captioned auto-ingest still lands in inbox first; if you deep-ingest from inbox without a prior shelf, prefer asking Jeon to tap ingest (picker) rather than inventing a project tree. (v1: button path is canonical)

- [ ] **Step 4: typecheck + raw-shelf tests**

Run: `npm run typecheck`  
Run: `npx tsx --test tests/raw-shelf.test.ts`  
Expected: clean / PASS

- [ ] **Step 5: Commit**

```powershell
git add src/telegram/ui.ts src/telegram/bot.ts src/agent/persona.ts persona/persona.md
git commit -m @"
Wire DM ingest through project picker and raw shelf.

"@
```

---

### Task 4: Archive media ingest

**Files:**
- Modify: `src/connectors/telegram/archiveUi.ts`
- Modify: `src/telegram/bot.ts` (`ar:` callbacks)
- Modify: `src/connectors/telegram/runtime.ts` (small helpers if needed)
- Optional test: `tests/raw-shelf-archive-ui.test.ts` for keyboard presence when `hasMedia`

**Interfaces:**
- Blob path: `path.join(cfg.telegramArchiveDir, 'blobs', 'sha256', hash.slice(0,2), hash)`
- Sticky: `runtime` / `TelegramProjectStore.getMapping(peerKey)?.wikiProject`
- Callbacks:
  - `ar:ing:<hitRef>:<queryRef>` — start ingest for anchor message media
  - If sticky: shelf first done media item (or show media picker if multiple)
  - Else: `ar:ingp:<hitRef>:<queryRef>:<projectRef>` after project picker

Keep v1 simple: ingest the **first** `status==='done' && blobHash` media on the **anchor** message. If none, toast “no downloaded media”.

- [ ] **Step 1: Add ingest button to archive window**

In `renderArchiveWindow`, if `win.anchor.hasMedia`, add  
`kb.text('📥 ingest media', \`ar:ing:${hitRef(anchor)}:${queryRef(query)}\`)`.

- [ ] **Step 2: Implement bot handlers**

On `ar:ing:`:
1. Parse hit `{peerKey,messageId}`
2. `loadTriageAttachments(peerKey, [messageId])`
3. Pick first done media with blobHash; resolve blob file path; if missing on disk → error
4. `displayName = filename ?? mediaKey`
5. Sticky project? → `fileToRaw` → `submitOwnerText` with raw path **and** provenance lines:  
   `Telegram provenance: ${peerKey}#${messageId}` / `blob:sha256:${hash}`
6. Else show project picker keyboard (`ar:ingp:...`)

On `ar:ingp:`: same shelf + ingest with chosen project.

- [ ] **Step 3: Tests / typecheck**

Add a small unit test that `renderArchiveWindow` includes ingest callback prefix when `hasMedia: true`.

Run: `npx tsx --test tests/raw-shelf.test.ts tests/tg-archive-ui.test.ts` (or new test file)  
Run: `npm run typecheck`

- [ ] **Step 4: Commit**

```powershell
git add src/connectors/telegram/archiveUi.ts src/telegram/bot.ts src/connectors/telegram/runtime.ts tests/*.ts
git commit -m @"
Add archive window ingest into project raw shelf.

"@
```

---

### Task 5: Verification gate

**Files:** none new (verify only)

- [ ] **Step 1: Run full test suite + selftest + typecheck**

```powershell
npm run typecheck
npm test
npm run selftest
```

Expected: typecheck clean; tests pass; selftest prints `ok`.

- [ ] **Step 2: Fix any failures**

- [ ] **Step 3: Commit only if fixes needed; otherwise done**

---

## Spec coverage check

| Spec requirement | Task |
|---|---|
| `raw_shelf` SQLite index | 1 |
| `fileToRaw` hardlink/copy + sha256 dedup + naming | 2 |
| DM always picker → shelf → deep-ingest | 3 |
| Archive sticky/picker → shelf → deep-ingest + cites | 4 |
| No auto-file on sync | 4 (button only) |
| Persona/runtime ownership of `raw/` | 3 |
| typecheck/selftest | 5 |
