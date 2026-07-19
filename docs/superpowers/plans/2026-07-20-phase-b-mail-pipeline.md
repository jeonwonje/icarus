# Phase B — Mail Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Daily Outlook `.pst` exports dropped in a watched folder get parsed, deduped, archived as markdown, and deep-triaged by an agent turn that DMs one digest.

**Architecture:** A croner poll job (`src/connectors/mail.ts`) watches `cfg.mailDropDir` for size-stable `.pst` files, parses them in-process with `pst-extractor`, writes each never-seen-before message to `inbox/connectors/mail/<date>/` (dedupe via the new `connector_items` table), then enqueues one `job:mail-triage` turn through the existing queue. The triage prompt carries the canonical digest style (`src/agent/digestStyle.ts`). Triage turns (only) get a browser MCP server, configured via `.env`.

**Tech Stack:** pst-extractor 1.12 (pure JS), croner, node:sqlite, existing queue/runner.

**Spec:** `docs/superpowers/specs/2026-07-20-comms-memory-ux-design.md` (Phase B sections B1–B5 + Cross-cutting digest style).

**One approved deviation from the spec:** B4 says the browser MCP command is "declared in config.ts, copied from the machine's working Claude MCP config at implementation time." That machine config is not reachable from this dev environment, so the concrete command lives in `.env` as `ICARUS_BROWSER_MCP` (a JSON object), parsed and validated in `config.ts`. Spirit preserved: explicit, code-level, triage-jobs-only; the machine-specific value stays machine-local.

## Global Constraints

- `npm run typecheck` clean; `npm run selftest` prints `ok`; `npm test` green after every task.
- Queue stays a single global lane. DDL only as a NEW appended `MIGRATIONS` string (never edit an applied one).
- `node:sqlite` rows need `as unknown as T` casts.
- Mail pipeline is fully optional: with `ICARUS_MAIL_DROP` unset, nothing registers and selftest still passes.
- Never commit `.env` or anything under `state/`, `inbox/`, `outbox/`.
- Test files import `./env.js` as their FIRST import (canonical env bootstrap — inline `process.env` lines are dead code under ESM import hoisting).
- Commits plain imperative, no attribution; use `-c user.name="Jeon" -c user.email="jeonwonje04@gmail.com"` if identity is unset.
- PST parsing cannot be unit-tested without a binary fixture — pure helpers get TDD; the PSTFile adapter is verified live on the deploy machine (documented per task).

---

### Task 1: connector_items migration + store helpers

**Files:**
- Modify: `src/db.ts` (append migration 2 to `MIGRATIONS`)
- Create: `src/connectors/store.ts`
- Modify: `src/main.ts` (selftest block only — the existing `tables:` line already prints new tables; add connector config lines in Task 5)
- Modify: `package.json` + `package-lock.json` (pst-extractor was already installed into the working tree by the controller — include both files in this task's commit)

**Interfaces:**
- Produces: `isProcessed(source: string, itemId: string): boolean` and `markProcessed(source: string, itemId: string): void` from `src/connectors/store.ts`; the `connector_items` table. Tasks 3/5 consume these.
- Consumes: nothing new.

- [ ] **Step 1: Append migration 2**

In `src/db.ts`, append a SECOND string to the `MIGRATIONS` array (do not touch the first):

```ts
  `
  CREATE TABLE connector_items (
    source TEXT NOT NULL,
    item_id TEXT NOT NULL,
    processed_at TEXT NOT NULL,
    PRIMARY KEY (source, item_id)
  );
  `,
```

- [ ] **Step 2: Create `src/connectors/store.ts`**

```ts
import { db, now } from '../db.js';

/** Permanent has-this-been-processed record for connector items (mail messages, files, TG batches). */
export function isProcessed(source: string, itemId: string): boolean {
  return !!db.prepare('SELECT 1 FROM connector_items WHERE source=? AND item_id=?').get(source, itemId);
}

export function markProcessed(source: string, itemId: string): void {
  db.prepare('INSERT OR IGNORE INTO connector_items(source,item_id,processed_at) VALUES(?,?,?)').run(
    source,
    itemId,
    now(),
  );
}
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm run selftest && npm test`
Expected: clean; selftest's `tables:` line now includes `connector_items`; existing tests stay green (5/5).

- [ ] **Step 4: Commit**

```bash
git add src/db.ts src/connectors/store.ts package.json package-lock.json
git commit -m "Add connector_items dedupe table and pst-extractor dependency"
```

---

### Task 2: Canonical digest style + persona reference + eval case

**Files:**
- Create: `src/agent/digestStyle.ts`
- Modify: `persona/persona.md` and `src/agent/persona.ts` (one bullet in "## Chat style", identical in both)
- Create: `evals/cases/digest-style.json`

**Interfaces:**
- Produces: `DIGEST_STYLE: string` from `src/agent/digestStyle.ts` (Task 5 embeds it in the triage prompt).
- Consumes: nothing new.

- [ ] **Step 1: Create `src/agent/digestStyle.ts`**

```ts
/** Canonical digest contract — embedded in triage job prompts; the persona references it. */
export const DIGEST_STYLE = `Digest format (hard contract):
- Urgent or action-needed items first, one line each: "▸ <label> · <what/when>".
- Then a short worth-knowing list, same one-line format.
- End with one line: "discarded N noise items" (omit when N is 0).
- No headers, no tables, no markdown emphasis. 15 lines maximum total.
- If nothing is worth saying, reply with an empty message — silence is a valid digest.`;
```

- [ ] **Step 2: Persona reference**

In `persona/persona.md`, "## Chat style" section, add as the last bullet:

```markdown
- Scheduled digests follow the digest contract given in the job prompt: ▸ one-liners,
  urgent first, 15-line budget, silence is a valid digest.
```

Identical bullet in `DEFAULT_PERSONA` in `src/agent/persona.ts`.

- [ ] **Step 3: Eval case**

First read one existing case (e.g. `evals/cases/brevity.json`) and match its exact field set. Create `evals/cases/digest-style.json` with the same shape:

```json
{
  "id": "digest-style",
  "prompt": "You just triaged 12 new emails: 2 urgent (CS2109 problem set due Friday; internship offer expires Monday), 3 mildly interesting (hall event, new library hours, a guest seminar), 7 obvious spam. Produce the digest DM for Jeon.",
  "rubric": "Reply is a compact digest: urgent items first as short one-line '▸' entries, then the minor items, ending with a discarded-count line; no headers, no tables, 15 lines or fewer."
}
```

(If the existing cases carry extra required fields, include them with sensible values; if `source_feedback_id` is optional, omit it.)

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm run selftest && npm test`
Expected: clean; selftest `persona:` char count grows; 5/5 tests. Do NOT run `npm run evals` (it spends real agent turns; the case is exercised by the nightly reflection flow on the deploy machine).

- [ ] **Step 5: Commit**

```bash
git add src/agent/digestStyle.ts persona/persona.md src/agent/persona.ts evals/cases/digest-style.json
git commit -m "Add canonical digest style, persona reference, and eval case"
```

---

### Task 3: Mail pure helpers (TDD)

**Files:**
- Create: `src/connectors/mail.ts` (helpers only in this task — the watcher lands in Task 5)
- Test: `tests/mail.test.ts`

**Interfaces:**
- Produces (all exported from `src/connectors/mail.ts`):
  - `slugify(s: string): string` — lowercase, non-alphanumerics → `-`, trimmed of leading/trailing `-`, max 60 chars, `'no-subject'` when empty
  - `fileSignature(name: string, size: number, mtimeMs: number): string` — `` `${name}|${size}|${Math.round(mtimeMs)}` ``
  - `messageId(msg: { internetMessageId: string; descriptorNodeId: number | { toString(): string }; messageDeliveryTime: Date | null }): string` — trimmed `internetMessageId` when non-empty, else `` `desc-${descriptorNodeId}-${iso-or-'unknown'}` `` (the loose `descriptorNodeId` type is deliberate: pst-extractor returns a `Long`, and template-literal interpolation stringifies both)
  - `renderMessageMd(m: MailMeta): string` and `interface MailMeta { id: string; from: string; fromEmail: string; to: string; date: string; subject: string; body: string }`
- Consumes: nothing new (helpers must NOT touch the db — Task 5 adds the db-touching watcher to this same file).

- [ ] **Step 1: Write the failing test**

Create `tests/mail.test.ts`:

```ts
import './env.js';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileSignature, messageId, renderMessageMd, slugify } from '../src/connectors/mail.js';

test('slugify normalizes subjects', () => {
  assert.equal(slugify('Re: [CS2109] Problem Set 3!!'), 're-cs2109-problem-set-3');
  assert.equal(slugify(''), 'no-subject');
  assert.equal(slugify('***'), 'no-subject');
  assert.equal(slugify('a'.repeat(100)).length, 60);
});

test('fileSignature is stable and mtime-rounded', () => {
  assert.equal(fileSignature('export.pst', 1024, 1700000000123.7), 'export.pst|1024|1700000000124');
});

test('messageId prefers internetMessageId, falls back to descriptor', () => {
  const dt = new Date('2026-07-19T08:00:00Z');
  assert.equal(
    messageId({ internetMessageId: ' <abc@mail.x> ', descriptorNodeId: 42, messageDeliveryTime: dt }),
    '<abc@mail.x>',
  );
  assert.equal(
    messageId({ internetMessageId: '', descriptorNodeId: 42, messageDeliveryTime: dt }),
    'desc-42-2026-07-19T08:00:00.000Z',
  );
  assert.equal(
    messageId({ internetMessageId: '  ', descriptorNodeId: 7, messageDeliveryTime: null }),
    'desc-7-unknown',
  );
});

test('renderMessageMd renders header and body', () => {
  const md = renderMessageMd({
    id: '<abc@mail.x>',
    from: 'Prof X',
    fromEmail: 'x@u.edu',
    to: 'jeon@u.edu',
    date: '2026-07-19T08:00:00.000Z',
    subject: 'PS3 due',
    body: 'Submit by Friday.',
  });
  assert.match(md, /^# PS3 due\n/);
  assert.match(md, /from: Prof X <x@u\.edu>/);
  assert.match(md, /date: 2026-07-19T08:00:00\.000Z/);
  assert.match(md, /id: <abc@mail\.x>/);
  assert.match(md, /\n\nSubmit by Friday\.\n$/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test`
Expected: FAIL — cannot find module `../src/connectors/mail.js`; queue/memory tests stay green.

- [ ] **Step 3: Implement the helpers**

Create `src/connectors/mail.ts`:

```ts
export interface MailMeta {
  id: string;
  from: string;
  fromEmail: string;
  to: string;
  date: string; // ISO
  subject: string;
  body: string;
}

export function slugify(s: string): string {
  const slug = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return slug || 'no-subject';
}

/** Identity of one on-disk export: same name+size+mtime ⇒ already handled. */
export function fileSignature(name: string, size: number, mtimeMs: number): string {
  return `${name}|${size}|${Math.round(mtimeMs)}`;
}

/** Stable per-message id: RFC internet id when present, else descriptor node + delivery time.
 *  descriptorNodeId is loose on purpose — pst-extractor returns a Long, tests pass a number. */
export function messageId(msg: {
  internetMessageId: string;
  descriptorNodeId: number | { toString(): string };
  messageDeliveryTime: Date | null;
}): string {
  const internet = msg.internetMessageId?.trim();
  if (internet) return internet;
  return `desc-${msg.descriptorNodeId}-${msg.messageDeliveryTime?.toISOString() ?? 'unknown'}`;
}

export function renderMessageMd(m: MailMeta): string {
  return [
    `# ${m.subject || '(no subject)'}`,
    '',
    `from: ${m.from} <${m.fromEmail}>`,
    `to: ${m.to}`,
    `date: ${m.date}`,
    `id: ${m.id}`,
    '',
    m.body.trim(),
    '',
  ].join('\n');
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test`
Expected: 9/9 passing.

- [ ] **Step 5: Typecheck, selftest, commit**

Run: `npm run typecheck && npm run selftest`

```bash
git add src/connectors/mail.ts tests/mail.test.ts
git commit -m "Add mail connector pure helpers"
```

---

### Task 4: Browser MCP for triage turns

**Files:**
- Modify: `src/config.ts` (env schema + `cfg.browserMcp`)
- Modify: `src/queue.ts` (TurnJob gains `browser?: boolean`)
- Modify: `src/agent/runner.ts` (conditionally add the browser MCP server)
- Modify: `.env.example`

**Interfaces:**
- Produces: `cfg.browserMcp?: { command: string; args?: string[]; env?: Record<string, string> }`; `TurnJob.browser?: boolean` — a turn submitted with `browser: true` gets the extra MCP server when configured. Task 5 consumes this flag.
- Consumes: nothing new.

- [ ] **Step 1: Parse the env var in `src/config.ts`**

Add to the `Env` zod object:

```ts
  ICARUS_MAIL_DROP: z.string().optional(),
  ICARUS_BROWSER_MCP: z.string().optional(),
```

After `const env = Env.parse(process.env);` add:

```ts
const BrowserMcp = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

function parseBrowserMcp(raw: string | undefined) {
  if (!raw) return undefined;
  try {
    return BrowserMcp.parse(JSON.parse(raw));
  } catch (e) {
    throw new Error(`ICARUS_BROWSER_MCP is not valid JSON {command,args?,env?}: ${String(e).slice(0, 200)}`);
  }
}
```

In `cfg`, after `defaultModel`:

```ts
  mailDropDir: env.ICARUS_MAIL_DROP || undefined,
  browserMcp: parseBrowserMcp(env.ICARUS_BROWSER_MCP),
```

- [ ] **Step 2: Thread the flag through the queue**

In `src/queue.ts`, add to the `TurnJob` interface after `capMs`:

```ts
  browser?: boolean; // give this turn the browser MCP server (triage jobs only)
```

(No `submitTurn` change needed — the field rides through the existing `Omit`.)

- [ ] **Step 3: Wire it in `src/agent/runner.ts`**

Replace the `mcpServers` option:

```ts
          mcpServers: {
            icarus: buildIcarusServer({ jid: job.jid, kind: job.kind, getSessionId: () => sessionId }),
            ...(job.browser && cfg.browserMcp ? { browser: { type: 'stdio' as const, ...cfg.browserMcp } } : {}),
          },
```

If the SDK's `McpServerConfig` type rejects this shape, cast the browser entry (`as never` on the entry, not the whole map) and note it in your report.

- [ ] **Step 4: Document in `.env.example`**

Append:

```
# Optional: folder where daily Outlook .pst exports land (enables the mail pipeline)
ICARUS_MAIL_DROP=
# Optional: browser MCP server for mail-triage turns, as JSON: {"command":"npx","args":["-y","chrome-devtools-mcp@latest"]}
# Copy the command/args from the machine's working Claude MCP config.
ICARUS_BROWSER_MCP=
```

- [ ] **Step 5: Verify and commit**

Run: `npm run typecheck && npm run selftest && npm test`
Expected: clean; `ok`; 9/9.

```bash
git add src/config.ts src/queue.ts src/agent/runner.ts .env.example
git commit -m "Add optional browser MCP server for triage turns"
```

---

### Task 5: PST watcher, parse, triage enqueue, stall nudge, status

**Files:**
- Modify: `src/connectors/mail.ts` (add the watcher/parse/enqueue on top of Task 3's helpers)
- Modify: `src/main.ts` (register watcher; selftest connector lines)
- Modify: `src/telegram/bot.ts` (`statusText()` mail line)

**Interfaces:**
- Consumes: `isProcessed`/`markProcessed` (Task 1), `DIGEST_STYLE` (Task 2), helpers (Task 3), `TurnJob.browser` (Task 4), `submitTurn` (existing), `sendOwner` (existing), `cfg.mailDropDir`.
- Produces: `registerMailWatcher(): void` and `pollMailDrop(): Promise<void>` from `src/connectors/mail.ts`. Settings keys: `mail_last_export_at` (ISO of last fresh export processed), `mail_last_parse` (`<ISO> · <n> new`), `mail_stall_notified` (dedupe key for the stall nudge).

- [ ] **Step 1: Add imports and the watcher to `src/connectors/mail.ts`**

Add at top (keeping Task 3's helpers below untouched):

```ts
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, statSync, writeFileSync, createWriteStream } from 'node:fs';
import path from 'node:path';
import { Cron } from 'croner';
import { PSTFile, PSTFolder, PSTMessage } from 'pst-extractor';
import { cfg } from '../config.js';
import { getSetting, now, setSetting } from '../db.js';
import { log } from '../log.js';
import { submitTurn } from '../queue.js';
import { DIGEST_STYLE } from '../agent/digestStyle.js';
import { sendOwner } from '../telegram/send.js';
import { isProcessed, markProcessed } from './store.js';
```

Then append the watcher section:

```ts
// ---- watcher ---------------------------------------------------------------

const STALL_MS = 36 * 60 * 60_000;
const sanitize = (name: string) => name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120);

/** name → last-seen size/mtime; a file is "ready" when unchanged across two polls. */
const pollState = new Map<string, { size: number; mtimeMs: number }>();

export function registerMailWatcher(): void {
  if (!cfg.mailDropDir) return;
  new Cron('*/5 * * * *', { protect: true }, () => void pollMailDrop());
  log.info({ dir: cfg.mailDropDir }, 'mail watcher registered');
}

export async function pollMailDrop(): Promise<void> {
  try {
    const dir = cfg.mailDropDir!;
    let names: string[];
    try {
      names = readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.pst'));
    } catch (e) {
      log.warn({ err: String(e) }, 'mail drop dir unreadable');
      return;
    }
    for (const name of names) {
      const p = path.join(dir, name);
      const st = statSync(p);
      const prev = pollState.get(name);
      pollState.set(name, { size: st.size, mtimeMs: st.mtimeMs });
      const ready = prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs;
      if (!ready) continue; // still syncing (or first sighting) — next poll decides
      const sig = fileSignature(name, st.size, st.mtimeMs);
      if (isProcessed('mail-file', sig)) continue;
      const newFiles = extractNewMessages(p);
      markProcessed('mail-file', sig);
      setSetting('mail_last_export_at', now());
      setSetting('mail_last_parse', `${now()} · ${newFiles.length} new`);
      log.info({ pst: name, newMessages: newFiles.length }, 'mail export parsed');
      if (newFiles.length > 0) enqueueTriage(newFiles);
    }
    checkStall();
  } catch (e) {
    log.error({ err: String(e) }, 'mail poll failed');
    await sendOwner(`mail pipeline error: ${String(e).slice(0, 300)}`);
  }
}

function checkStall(): void {
  const last = getSetting('mail_last_export_at');
  if (!last) return; // never seen an export — nothing to compare against
  if (Date.now() - new Date(last).getTime() < STALL_MS) return;
  if (getSetting('mail_stall_notified') === last) return; // already nudged for this stall
  setSetting('mail_stall_notified', last);
  void sendOwner(`mail export seems stalled — last fresh export ${last.slice(0, 16)}. Is the daily export task still running?`);
}
```

- [ ] **Step 2: Add extraction + triage enqueue (same file, below the watcher)**

```ts
// ---- extraction ------------------------------------------------------------

/** Walk the PST, write never-seen messages + attachments to the inbox, return new file paths. */
function extractNewMessages(pstPath: string): string[] {
  const pst = new PSTFile(pstPath);
  const written: string[] = [];
  walkFolder(pst.getRootFolder(), written);
  return written;
}

function walkFolder(folder: PSTFolder, written: string[]): void {
  if (folder.hasSubfolders) for (const sub of folder.getSubFolders()) walkFolder(sub, written);
  if (folder.contentCount <= 0) return;
  let child = folder.getNextChild();
  while (child) {
    if (child instanceof PSTMessage && child.messageClass.startsWith('IPM.Note')) {
      try {
        const p = writeMessage(child);
        if (p) written.push(p);
      } catch (e) {
        log.warn({ err: String(e), subject: child.subject }, 'skipping unparseable message');
      }
    }
    child = folder.getNextChild();
  }
}

function writeMessage(msg: PSTMessage): string | null {
  const id = messageId(msg);
  if (isProcessed('mail', id)) return null;
  const delivered = msg.messageDeliveryTime;
  const day = (delivered ?? new Date()).toISOString().slice(0, 10);
  const dir = path.join(cfg.inboxDir, 'connectors', 'mail', day);
  mkdirSync(dir, { recursive: true });
  const base = `${slugify(msg.subject)}-${createHash('sha256').update(id).digest('hex').slice(0, 8)}`;
  const mdPath = path.join(dir, `${base}.md`);
  writeFileSync(
    mdPath,
    renderMessageMd({
      id,
      from: msg.senderName,
      fromEmail: msg.senderEmailAddress,
      to: msg.displayTo,
      date: delivered?.toISOString() ?? 'unknown',
      subject: msg.subject,
      body: msg.body || msg.bodyHTML,
    }),
  );
  if (msg.numberOfAttachments > 0) writeAttachments(msg, path.join(dir, `${base}-att`));
  markProcessed('mail', id);
  return mdPath;
}

function writeAttachments(msg: PSTMessage, dir: string): void {
  for (let i = 0; i < msg.numberOfAttachments; i++) {
    try {
      const att = msg.getAttachment(i);
      const stream = att.fileInputStream;
      if (!stream) continue;
      mkdirSync(dir, { recursive: true });
      const name = sanitize(att.longFilename || att.filename || `attachment-${i}`);
      const out = createWriteStream(path.join(dir, name));
      const buffer = Buffer.alloc(8176);
      let bytesRead: number;
      do {
        bytesRead = stream.readBlock(buffer);
        if (bytesRead > 0) out.write(buffer.subarray(0, bytesRead));
      } while (bytesRead === buffer.length);
      out.end();
    } catch (e) {
      log.warn({ err: String(e), i }, 'attachment extraction failed');
    }
  }
}

// ---- triage ----------------------------------------------------------------

function enqueueTriage(files: string[]): void {
  const prompt = `You are running the mail triage job. ${files.length} new email(s) landed as markdown files (attachments in sibling "-att" dirs):

${files.map((f) => `- ${f}`).join('\n')}

Read EVERY file. Discard spam/noise silently. For anything real, actually investigate: follow links (browser tools are available for pages WebFetch can't handle), read attachments and images, extract deadlines, actions, and amounts. Record durable facts in your memory directory. For hard deadlines, surface them prominently in the digest (calendar integration comes later).

Your final reply is DMed to Jeon as the mail digest.

${DIGEST_STYLE}`;
  submitTurn({
    jid: 'job:mail-triage',
    kind: 'job:mail-triage',
    lines: [{ ts: new Date(), text: prompt }],
    capMs: cfg.reflectionCapMs,
    browser: true,
    onDone: (res) => {
      const body = res.status === 'ok' ? res.finalText : `mail triage failed: ${res.error ?? 'unknown'}`;
      if (body.trim()) void sendOwner(body);
    },
  });
}
```

Note: `messageId(msg)` works because `PSTMessage` structurally provides `internetMessageId`, `messageDeliveryTime`, and (via its `PSTObject` base) `descriptorNodeId: Long` — the helper's loose `descriptorNodeId` type accepts it directly.

- [ ] **Step 3: Wire boot + selftest in `src/main.ts`**

In the selftest block, after the `tz:` line:

```ts
  console.log(`  mail drop: ${cfg.mailDropDir ?? 'unset'}  browser mcp: ${cfg.browserMcp ? 'configured' : 'unset'}`);
```

In the full-service section, next to `registerCodeJobs()`:

```ts
const { registerMailWatcher } = await import('./connectors/mail.js');
registerMailWatcher();
```

- [ ] **Step 4: `/status` mail line in `src/telegram/bot.ts`**

In `statusText()`, add to the returned array before the token-age line:

```ts
    ...(cfg.mailDropDir
      ? [`▸ mail · export ${getSetting('mail_last_export_at')?.slice(0, 16) ?? 'never'} · parse ${getSetting('mail_last_parse') ?? 'never'}`]
      : []),
```

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm run selftest && npm test`
Expected: clean; selftest prints `mail drop: unset  browser mcp: unset` and `ok`; 9/9 tests.

Live verification (deferred to deploy machine, document in report): set `ICARUS_MAIL_DROP`, drop a real export, watch two polls, confirm raw md files + digest DM + dedupe on a second identical drop.

- [ ] **Step 6: Commit**

```bash
git add src/connectors/mail.ts src/main.ts src/telegram/bot.ts
git commit -m "Add mail pipeline: pst watcher, extraction, deep-triage digest"
```
