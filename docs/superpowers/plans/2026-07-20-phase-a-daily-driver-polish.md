# Phase A — Daily-Driver Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a stop button for running turns, route photos straight into the conversation as visual context, and give Icarus a markdown long-term memory injected into every turn.

**Architecture:** Three independent features on the existing single-lane queue/turn architecture. The queue owns turn `AbortController`s so the bot can abort from outside the runner; photos bypass the file-action keyboard and become normal turns; memory is a `wiki/memory/` directory whose `MEMORY.md` index is injected per turn via the existing `UserPromptSubmit` context hook, maintained by the persona during turns and a new nightly system schedule.

**Tech Stack:** TypeScript ESM on Node 24 via tsx (no build step), grammY, `node:sqlite`, croner, `node:test` via `tsx --test` (new — this plan introduces the test script).

**Spec:** `docs/superpowers/specs/2026-07-20-comms-memory-ux-design.md` (Phase A sections A1–A3).

## Global Constraints

- `npm run typecheck` must stay clean and `npm run selftest` must print `ok` after every task.
- The queue stays a single global lane; do not add concurrency.
- `node:sqlite` rows need `as unknown as T` casts.
- DDL only via a new appended string in `MIGRATIONS` in `src/db.ts` — never edit an applied one. (No migration is needed in Phase A.)
- Never commit `.env` or anything under `state/`, `inbox/`, `outbox/`.
- The guard hook (`src/agent/guard.ts`) is not touched in this phase.
- Persona files (`persona/persona.md`) are runtime-edited by the approval flow; hand-edits made here must be committed so `/revert` history stays clean.
- Commit messages are plain, imperative, no attribution lines (project convention; repo identity: commit with `-c user.name="Jeon" -c user.email="jeonwonje04@gmail.com"` if repo-local git identity is still unset).

---

### Task 1: Abortable turns (queue + runner) and the test script

**Files:**
- Modify: `src/queue.ts` (TurnJob interface ~line 15, `submitTurn` ~line 38; new `abortRunning`)
- Modify: `src/agent/runner.ts:60` (use the job's controller instead of a local one)
- Modify: `package.json` (add `test` script)
- Test: `tests/queue-abort.test.ts` (new; new directory)

**Interfaces:**
- Produces: `TurnJob.ac: AbortController` (created by `submitTurn`, aborted by cap/idle timers and by callers); `abortRunning(reason?: string): boolean` exported from `src/queue.ts` — aborts the currently running job (chat or scheduled) with `new Error(reason ?? 'stopped by you')`, returns `false` when nothing is running. Task 2 consumes `abortRunning`.
- Consumes: nothing from other tasks.

- [ ] **Step 1: Add the test script**

In `package.json` `"scripts"`, after `"evals"`:

```json
    "evals": "tsx src/main.ts --evals",
    "test": "tsx --test \"tests/*.test.ts\""
```

- [ ] **Step 2: Write the failing test**

Create `tests/queue-abort.test.ts`:

```ts
// Env must satisfy src/config.ts before any src import (loadEnvFile never overrides these).
process.env.TELEGRAM_BOT_TOKEN ??= 'test-token-0123456789';
process.env.TELEGRAM_OWNER_ID ??= '1';
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token-0123456789';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abortRunning, initQueue, submitTurn, type TurnJob, type TurnResult } from '../src/queue.js';

test('abortRunning returns false when idle', () => {
  assert.equal(abortRunning(), false);
});

test('abortRunning aborts the running job via its AbortController', async () => {
  let done!: (r: TurnResult) => void;
  const result = new Promise<TurnResult>((res) => (done = res));

  initQueue(async (job: TurnJob) => {
    // Fake runner: finish only when aborted, echoing the abort reason like runTurn does.
    await new Promise<void>((res) => job.ac.signal.addEventListener('abort', () => res()));
    const reason = job.ac.signal.reason;
    return { status: 'aborted', finalText: '', error: reason instanceof Error ? reason.message : 'aborted' };
  });

  submitTurn({
    jid: 'dm:owner',
    kind: 'chat',
    lines: [{ ts: new Date(), text: 'hi' }],
    onDone: (r) => done(r),
  });

  await new Promise((r) => setTimeout(r, 20)); // let pump() start the job
  assert.equal(abortRunning(), true);

  const res = await result;
  assert.equal(res.status, 'aborted');
  assert.equal(res.error, 'stopped by you');

  await new Promise((r) => setTimeout(r, 20)); // let pump() clear `running`
  assert.equal(abortRunning(), false);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `src/queue.js` has no export named `abortRunning` (module load error), and TS would also flag `job.ac`.

- [ ] **Step 4: Implement in `src/queue.ts`**

Add `ac` to the `TurnJob` interface:

```ts
export interface TurnJob {
  jid: string;
  kind: string; // 'chat' | 'job:<name>' | 'eval'
  lines: TurnLine[];
  capMs?: number;
  onText?: (text: string) => void;
  onDone?: (result: TurnResult) => void;
  enqueuedAt: number;
  ac: AbortController;
}
```

In `submitTurn`, widen the `Omit` and create the controller:

```ts
export function submitTurn(job: Omit<TurnJob, 'enqueuedAt' | 'ac'>): void {
  const existing = pending.find((j) => j.jid === job.jid);
  if (existing) {
    existing.lines.push(...job.lines);
    return;
  }
  const j: TurnJob = { ...job, enqueuedAt: Date.now(), ac: new AbortController() };
```

(rest of `submitTurn` unchanged). Add next to `queueStatus`:

```ts
/** Abort whatever turn is currently running (chat or job). False when idle. */
export function abortRunning(reason = 'stopped by you'): boolean {
  if (!running) return false;
  running.ac.abort(new Error(reason));
  return true;
}
```

- [ ] **Step 5: Point the runner at the job's controller**

In `src/agent/runner.ts`, inside `attempt`, replace:

```ts
    const ac = new AbortController();
```

with:

```ts
    const ac = job.ac;
```

Nothing else changes — the hard-cap and idle timers already call `ac.abort(...)`, and the existing `ac.signal.aborted` check after the stream loop turns an external abort into the existing `status: 'aborted'` result. (The resume-repair retry reuses the same controller; an abort never triggers that retry path, so a shared controller is safe.)

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm test`
Expected: 2 passing tests.

- [ ] **Step 7: Typecheck and selftest**

Run: `npm run typecheck && npm run selftest`
Expected: no type errors; selftest ends with `ok`.

- [ ] **Step 8: Commit**

```bash
git add package.json tests/queue-abort.test.ts src/queue.ts src/agent/runner.ts
git commit -m "Make running turns abortable from outside the runner"
```

---

### Task 2: ⏹ stop button and /stop command

**Files:**
- Modify: `src/telegram/send.ts` (two new helpers at the end)
- Modify: `src/telegram/bot.ts` (arm/disarm logic near `submitOwnerText` ~line 29; `turn:stop` callback in `handleCallback`; `/stop` command; command registration ~line 355; unknown-command hint ~line 344)

**Interfaces:**
- Consumes: `abortRunning()` from Task 1.
- Produces: `sendOwnerEphemeral(text: string, keyboard: InlineKeyboard): Promise<number | null>` and `deleteOwnerMessage(messageId: number): Promise<void>` in `src/telegram/send.ts`. No later task depends on this one.

Behavior contract (from spec A1): the button message appears only once an owner turn has been in flight >10 s, is deleted when the owner queue drains, and both ⏹ and `/stop` abort *whatever* is currently running — including a scheduled job the owner turn is queued behind; stopping it is how the owner unblocks their own turn.

- [ ] **Step 1: Add send helpers**

Append to `src/telegram/send.ts`:

```ts
/** Send a short-lived owner message with a keyboard; returns its id for later deletion. */
export async function sendOwnerEphemeral(text: string, keyboard: InlineKeyboard): Promise<number | null> {
  try {
    const m = await bot.api.sendMessage(cfg.ownerId, text, { reply_markup: keyboard });
    return m.message_id;
  } catch (e) {
    log.error({ err: String(e) }, 'sendOwnerEphemeral failed');
    return null;
  }
}

export async function deleteOwnerMessage(messageId: number): Promise<void> {
  await bot.api.deleteMessage(cfg.ownerId, messageId).catch(() => {
    /* already gone — fine */
  });
}
```

(`InlineKeyboard` is already imported in send.ts.)

- [ ] **Step 2: Arm/disarm the button around owner turns**

In `src/telegram/bot.ts`, extend the send.js import with `sendOwnerEphemeral` and `deleteOwnerMessage`, and extend the queue.js import with `abortRunning`. Below `let typingStop` add:

```ts
let stopUi: { timer: NodeJS.Timeout; msgId: number | null } | null = null;

function armStopButton(): void {
  if (stopUi) return;
  stopUi = {
    msgId: null,
    timer: setTimeout(async () => {
      const msgId = await sendOwnerEphemeral('working… tap to stop', new InlineKeyboard().text('⏹ stop', 'turn:stop'));
      if (stopUi) stopUi.msgId = msgId;
      else if (msgId) void deleteOwnerMessage(msgId); // turn finished during the send
    }, 10_000),
  };
}

function disarmStopButton(): void {
  if (!stopUi) return;
  clearTimeout(stopUi.timer);
  if (stopUi.msgId) void deleteOwnerMessage(stopUi.msgId);
  stopUi = null;
}
```

In `submitOwnerText`, arm alongside typing and disarm alongside its stop:

```ts
export function submitOwnerText(text: string): void {
  // Coalesced submits share one turn (and one onDone), so typing is a single toggle:
  // start on any submit, stop when no owner turn remains queued.
  if (!typingStop) typingStop = startTyping();
  armStopButton();
  submitTurn({
    jid: OWNER_JID,
    kind: 'chat',
    lines: [{ ts: new Date(), text }],
    onText: (t) => void sendOwner(t),
    onDone: (res) => {
      if (!hasPending(OWNER_JID)) {
        disarmStopButton();
        if (typingStop) {
          typingStop();
          typingStop = null;
        }
      }
      if (res.status === 'aborted') void sendOwner(`(turn aborted: ${res.error})`);
      else if (res.status === 'error') void sendOwner(`turn failed: ${res.error}`);
    },
  });
}
```

- [ ] **Step 3: Handle the callback and the command**

In `handleCallback`, before the `prop:` block:

```ts
  if (data === 'turn:stop') {
    const stopped = abortRunning();
    await ctx.answerCallbackQuery({ text: stopped ? 'stopping…' : 'nothing running' });
    return;
  }
```

In `createBot`, next to the other commands:

```ts
  bot.command('stop', async (ctx) => {
    await ctx.reply(abortRunning() ? 'stopping the current turn…' : 'nothing is running.');
  });
```

Update the unknown-command reply string to `'unknown command — /status /wiki /schedules /model /stop /clear /feedback /revert /restart'`, and add to `registerCommands` after the `clear` entry:

```ts
    { command: 'stop', description: 'abort the running turn' },
```

- [ ] **Step 4: Typecheck and selftest**

Run: `npm run typecheck && npm run selftest`
Expected: clean; `ok`.

- [ ] **Step 5: Manual smoke (deploy machine or dev bot)**

This is Telegram-side UI; there is no unit seam worth mocking grammY for. Verify live after `/restart`:
1. Ask something slow ("read every file in the wiki and summarize each") → after ~10 s a `working… tap to stop` message appears.
2. Tap ⏹ → callback toast `stopping…`, then `(turn aborted: stopped by you)` arrives and the working message disappears.
3. Ask something trivial ("say hi") → no working message ever appears.
4. `/stop` while idle → `nothing is running.`

- [ ] **Step 6: Commit**

```bash
git add src/telegram/send.ts src/telegram/bot.ts
git commit -m "Add stop button and /stop for running turns"
```

---

### Task 3: Photos join the conversation

**Files:**
- Modify: `src/telegram/bot.ts` (message handler, the `if (saved)` block ~line 329)
- Modify: `persona/persona.md` (the "## Files Jeon sends" section)
- Modify: `src/agent/persona.ts` (`DEFAULT_PERSONA`, same section — keeps fresh installs in sync)

**Interfaces:**
- Consumes: `submitOwnerText` (existing). Produces nothing later tasks use.

- [ ] **Step 1: Route photos straight to the agent**

In the `bot.on('message')` handler, replace the `if (saved) { ... }` block body with:

```ts
      if (saved) {
        const caption = ctx.message.caption?.trim();
        if (ctx.message.photo) {
          submitOwnerText(`${caption ?? 'Look at this image and respond.'}\n(image: ${saved.savedPath})`);
        } else if (caption) {
          await ctx.reply(`received ${saved.name} → inbox`);
          submitOwnerText(`${caption}\n(file received: ${saved.savedPath})`);
        } else {
          await ctx.reply(`received ${saved.name} → inbox — what should I do with it?`, {
            reply_markup: fileActionKeyboard(saved.savedPath),
          });
        }
        return;
      }
```

No ack message for photos — the typing indicator (and, if slow, the Task 2 stop button) is the ack. Documents, audio, video, and video notes keep the button flow.

- [ ] **Step 2: Teach the persona**

In `persona/persona.md`, section "## Files Jeon sends", insert after the first bullet ("Incoming files land in…"):

```markdown
- Photos come straight to you with an `(image: <path>)` line — always Read that path
  first so you actually see the image, then respond to it (and the caption, if any).
```

And change the without-caption bullet's first words from "Files sent WITHOUT a caption" to "Non-photo files sent WITHOUT a caption". Make the identical two edits in `DEFAULT_PERSONA` in `src/agent/persona.ts`.

- [ ] **Step 3: Typecheck and selftest**

Run: `npm run typecheck && npm run selftest`
Expected: clean; `ok` (selftest also prints the new persona char count — fine).

- [ ] **Step 4: Manual smoke**

1. Send a photo with caption "what is this?" → no buttons; a real answer about the image arrives.
2. Send a photo with no caption → it describes/responds to the image.
3. Send a PDF with no caption → ingest/summarize/keep buttons still appear.

- [ ] **Step 5: Commit**

```bash
git add src/telegram/bot.ts persona/persona.md src/agent/persona.ts
git commit -m "Send photos straight to the agent as visual context"
```

---

### Task 4: Memory module, scaffold, and per-turn injection

**Files:**
- Create: `src/agent/memory.ts`
- Modify: `src/config.ts` (add `memoryDir` to `cfg`, after `wikiDir`)
- Modify: `src/agent/contextHook.ts` (inject the memory block)
- Modify: `src/main.ts` (scaffold at boot, ~line 10)
- Test: `tests/memory.test.ts`

**Interfaces:**
- Produces: `scaffoldMemory(dir: string): void` and `buildMemoryBlock(dir: string): string | null` and `MEMORY_CAP = 4_096` from `src/agent/memory.ts`; `cfg.memoryDir: string` (= `<Desktop>/wiki/memory`). Task 5's seeded prompt embeds `cfg.memoryDir`.
- Consumes: nothing from other tasks.

- [ ] **Step 1: Write the failing test**

Create `tests/memory.test.ts`:

```ts
process.env.TELEGRAM_BOT_TOKEN ??= 'test-token-0123456789';
process.env.TELEGRAM_OWNER_ID ??= '1';
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token-0123456789';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildMemoryBlock, MEMORY_CAP, scaffoldMemory } from '../src/agent/memory.js';

const fresh = () => mkdtempSync(path.join(tmpdir(), 'icarus-mem-'));

test('missing dir or index yields null', () => {
  assert.equal(buildMemoryBlock(path.join(fresh(), 'nope')), null);
});

test('scaffold seeds MEMORY.md once and the block wraps it', () => {
  const dir = fresh();
  scaffoldMemory(dir);
  const block = buildMemoryBlock(dir);
  assert.ok(block?.startsWith(`<memory dir="${dir}">`));
  assert.ok(block?.endsWith('</memory>'));
  writeFileSync(path.join(dir, 'MEMORY.md'), 'custom');
  scaffoldMemory(dir); // must not overwrite
  assert.match(buildMemoryBlock(dir)!, /custom/);
});

test('oversized index is truncated with a warning', () => {
  const dir = fresh();
  scaffoldMemory(dir);
  writeFileSync(path.join(dir, 'MEMORY.md'), 'x'.repeat(MEMORY_CAP + 500));
  const block = buildMemoryBlock(dir)!;
  assert.ok(block.length < MEMORY_CAP + 300);
  assert.match(block, /truncated/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot find module `../src/agent/memory.js`.

- [ ] **Step 3: Implement `src/agent/memory.ts`**

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const MEMORY_CAP = 4_096;

const DEFAULT_INDEX = `# Memory index

One line per durable fact, grouped under short topic headers. Detail lives in topic
files beside this one (people.md, preferences.md, per-project notes) — this file is
injected into every turn, so keep it small and keep it an index.
`;

export function scaffoldMemory(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const index = path.join(dir, 'MEMORY.md');
  if (!existsSync(index)) writeFileSync(index, DEFAULT_INDEX);
}

/** MEMORY.md as an injectable block, capped so a bloated index can't flood every turn. */
export function buildMemoryBlock(dir: string): string | null {
  let text: string;
  try {
    text = readFileSync(path.join(dir, 'MEMORY.md'), 'utf8').trim();
  } catch {
    return null;
  }
  if (!text) return null;
  const capped =
    text.length <= MEMORY_CAP
      ? text
      : text.slice(0, MEMORY_CAP) +
        `\n[truncated — MEMORY.md exceeds ${MEMORY_CAP} chars; consolidate detail into topic files]`;
  return `<memory dir="${dir}">\n${capped}\n</memory>`;
}
```

- [ ] **Step 4: Wire config, context hook, and boot**

`src/config.ts` — in `cfg` after `wikiDir`:

```ts
  memoryDir: path.join(DESKTOP, 'wiki', 'memory'),
```

`src/agent/contextHook.ts` — add `import { buildMemoryBlock } from './memory.js';`, then inside the hook after the `<outbox …>` push:

```ts
    const memory = buildMemoryBlock(cfg.memoryDir);
    if (memory) parts.push(memory);
```

`src/main.ts` — extend the persona import line and scaffold call:

```ts
const { composePersona, scaffoldPersona } = await import('./agent/persona.js');
const { scaffoldMemory } = await import('./agent/memory.js');

scaffoldPersona();
scaffoldMemory(cfg.memoryDir);
```

- [ ] **Step 5: Run tests, typecheck, selftest**

Run: `npm test && npm run typecheck && npm run selftest`
Expected: 5 tests passing (2 from Task 1); clean; `ok`.

- [ ] **Step 6: Commit**

```bash
git add src/agent/memory.ts src/config.ts src/agent/contextHook.ts src/main.ts tests/memory.test.ts
git commit -m "Add markdown memory dir with per-turn index injection"
```

---

### Task 5: Memory persona instructions and nightly consolidation schedule

**Files:**
- Modify: `src/config.ts` (export `MEMORY_JOB` next to `REFLECTION_JOB`)
- Modify: `src/scheduler/scheduler.ts` (`seedSystemRows`, line 134)
- Modify: `persona/persona.md` and `src/agent/persona.ts` (new "## Memory" section after "## Schedules")

**Interfaces:**
- Consumes: `cfg.memoryDir` from Task 4.
- Produces: `MEMORY_JOB = 'memory-consolidation'` in `src/config.ts`; a seeded system schedule row of that name. Nothing later depends on it.

- [ ] **Step 1: Add the job name constant**

In `src/config.ts`, after `export const REFLECTION_JOB = 'reflection';`:

```ts
export const MEMORY_JOB = 'memory-consolidation';
```

- [ ] **Step 2: Seed the system schedule**

Replace `seedSystemRows` in `src/scheduler/scheduler.ts` (add `MEMORY_JOB` to the config import):

```ts
export function seedSystemRows(): void {
  const insert = db.prepare(
    `INSERT INTO schedules(name,cron,tz,prompt,enabled,catch_up,system,created_at,updated_at)
     VALUES(?,?,NULL,?,1,1,1,?,?)`,
  );
  const ts = now();
  if (!db.prepare('SELECT id FROM schedules WHERE name=?').get(REFLECTION_JOB))
    insert.run(REFLECTION_JOB, '30 3 * * *', '(dynamic — built by reflect.ts each run)', ts, ts);
  if (!db.prepare('SELECT id FROM schedules WHERE name=?').get(MEMORY_JOB))
    insert.run(
      MEMORY_JOB,
      '15 4 * * *',
      `Consolidate the memory directory at ${cfg.memoryDir}. Merge duplicate entries across ` +
        `topic files, prune stale or superseded facts, and keep MEMORY.md an accurate index of ` +
        `one-liners under 4 KB (detail belongs in topic files, not the index). Surgical edits ` +
        `only — never rewrite wholesale. Reply with one short line describing what changed, ` +
        `e.g. "merged 2 duplicate people entries" or "no changes needed".`,
      ts,
      ts,
    );
}
```

(Runs at 04:15, between the 03:30 reflection and the 05:00 token canary, with `catch_up=1` like reflection so a night the laptop slept still consolidates on boot. The generic `fire()` path handles it — only `reflection` is special-cased.)

- [ ] **Step 3: Teach the persona**

In `persona/persona.md`, insert a new section between "## Schedules" and "## Feedback":

```markdown
## Memory

- wiki\memory\ is your long-term memory. MEMORY.md is a small index of one-liners,
  injected into every turn inside <memory>; detail lives in topic files beside it
  (people.md, preferences.md, per-project notes).
- When a turn surfaces something durable — a fact, decision, preference, or relationship
  worth knowing weeks from now — update the relevant topic file in the same turn and add
  or adjust its index line. Don't announce it; just do it.
- When the index suggests a topic file is relevant to the current request, read it before
  answering.
- Memory is about Jeon's life. record_feedback is about how you work. Don't cross them.
```

Make the identical insertion in `DEFAULT_PERSONA` in `src/agent/persona.ts` (with `\\` escaping for `wiki\\memory\\`).

- [ ] **Step 4: Typecheck, selftest, tests**

Run: `npm run typecheck && npm run selftest && npm test`
Expected: clean; `ok`; 5 tests passing.

- [ ] **Step 5: Manual smoke**

1. After `/restart`, `/schedules` shows `memory-consolidation` as a system schedule with next fire 04:15.
2. Tell Icarus a durable fact ("remember my sister's birthday is March 3rd") → `wiki/memory/people.md` (or similar) gains it and `MEMORY.md` gains an index line.
3. `/clear`, then ask "when is my sister's birthday?" → answered from memory.
4. Run the schedule via its ▶ button → one-line result DM arrives.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/scheduler/scheduler.ts persona/persona.md src/agent/persona.ts
git commit -m "Add memory persona rules and nightly consolidation schedule"
```
