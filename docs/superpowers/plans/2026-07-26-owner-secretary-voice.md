# Owner Secretary Voice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every owner-facing Icarus surface sound like a warm-crisp executive secretary via a shared `ownerVoice` module plus persona/lessons rewrites.

**Architecture:** Pure copy helpers in `src/agent/ownerVoice.ts` own all fixed plumbing DMs. Agent turns follow the same voice contract through `persona/persona.md` and scaffold defaults. Call sites keep `sendOwner*` transport; they stop inventing ticket-speak literals.

**Tech Stack:** TypeScript ESM, grammy `InlineKeyboard`, node:test, existing evals runner.

**Spec:** `docs/superpowers/specs/2026-07-26-owner-secretary-voice-design.md`

## Global Constraints

- `npm run typecheck` clean; `npm run selftest` prints `ok`; `npm test` green after every task.
- Voice: warm-crisp secretary; no AI filler; no ticket labels (`Evidence:`, `Cause:`, `Self-edit proposal`, `Telegram → wiki mapping proposal`).
- Routine filing silent; speak when worth knowing or needs a decision.
- Proposal DMs: why → tiny what-changes → Approve/Reject; callback data unchanged (`prop:${id}:approve|reject`, `tgmap:ok|no:${id}`).
- Single global agent lane — no new concurrency.
- Never commit `.env`, `state/`, `inbox/`, `outbox/`, `artifacts/`, `archive/`.
- Commits: plain imperative, no Claude attribution.
- Test files import `./env.js` first.

## File structure

| File | Responsibility |
|---|---|
| `src/agent/ownerVoice.ts` | All fixed owner-facing copy helpers |
| `tests/owner-voice.test.ts` | Conversational shape + banned-label assertions |
| `src/connectors/telegram/projectUi.ts` | Thin wrap → `ownerVoice.proposal.telegramMap` |
| `src/improve/proposals.ts` | Use `ownerVoice.proposal.selfEdit` |
| `src/main.ts`, `src/telegram/bot.ts`, `src/telegram/send.ts`, `src/agent/runner.ts`, `src/scheduler/jobs.ts`, `src/connectors/mail.ts` | Migrate literals to ownerVoice |
| `persona/persona.md`, `persona/lessons.md` | Voice contract for agent turns |
| `src/agent/persona.ts` | Scaffold defaults match |
| `evals/cases/secretary-voice.json` | Eval: no chatbot preamble / ticket tone |

---

### Task 1: ownerVoice module + unit tests

**Files:**
- Create: `src/agent/ownerVoice.ts`
- Create: `tests/owner-voice.test.ts`

**Interfaces:**
- Produces: `export const ownerVoice` matching the spec API (online, turn, proposal, ops).
- `proposal.telegramMap` returns `{ text, keyboard }` with callbacks `tgmap:ok:${id}` / `tgmap:no:${id}`.
- `proposal.selfEdit` returns `{ text, approveLabel, rejectLabel, diffCaption }` — callers build the keyboard with `prop:${id}:approve|reject`.

- [ ] **Step 1: Write the failing test** in `tests/owner-voice.test.ts`

```ts
import './env.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ownerVoice } from '../src/agent/ownerVoice.js';

const BANNED = [
  /Evidence:/i,
  /Cause:/i,
  /Predicted impact:/i,
  /Self-edit proposal/i,
  /Telegram\s*→\s*wiki mapping proposal/i,
  /^turn failed:/m,
];

function assertHuman(text: string) {
  for (const re of BANNED) assert.doesNotMatch(text, re);
  assert.ok(text.trim().length > 0);
}

test('selfEdit is conversational and keeps decision clear', () => {
  const r = ownerVoice.proposal.selfEdit({
    id: 7,
    target: 'persona',
    why: 'Replies were reading like a ticket system.',
    whatChanges: 'Softer chat-style lines in persona.',
    evalSummary: '3/3 eval cases passed',
  });
  assertHuman(r.text);
  assert.match(r.text, /persona/i);
  assert.match(r.text, /Softer chat-style|what changes|change/i);
  assert.equal(r.approveLabel, 'Approve');
  assert.equal(r.rejectLabel, 'Reject');
  assert.ok(!r.diffCaption.toLowerCase().includes('self-edit proposal'));
});

test('telegramMap asks in plain English with stable callbacks', () => {
  const r = ownerVoice.proposal.telegramMap({
    id: 3,
    chatTitle: 'Morian Labs build',
    wikiProject: 'morianlabs',
    why: 'Title and recent msgs line up with the morianlabs wiki folder.',
  });
  assertHuman(r.text);
  assert.match(r.text, /Morian Labs build/);
  assert.match(r.text, /morianlabs/);
  const flat = JSON.stringify(r.keyboard.inline_keyboard);
  assert.match(flat, /tgmap:ok:3/);
  assert.match(flat, /tgmap:no:3/);
});

test('ops and turn lines drop status-log prefixes', () => {
  assertHuman(ownerVoice.turn.failed('boom'));
  assert.doesNotMatch(ownerVoice.turn.failed('boom'), /^turn failed:/);
  assertHuman(ownerVoice.online.recovered());
  assertHuman(ownerVoice.ops.mailStalled('2026-07-26T01:00:00.000Z'));
  assertHuman(ownerVoice.ops.archiveFailedToStart('timeout'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/owner-voice.test.ts`
Expected: FAIL (module missing)

- [ ] **Step 3: Implement `src/agent/ownerVoice.ts`**

```ts
import { InlineKeyboard } from 'grammy';
import { clip } from '../telegram/ui.js';

function clipErr(detail: string, n = 200): string {
  return detail.length <= n ? detail : detail.slice(0, n);
}

export const ownerVoice = {
  online: {
    firstTime(): string {
      return `I'm online for the first time. Talk to me, send files, or try /status.`;
    },
    recovered(): string {
      return `I'm back — looks like we recovered from a crash or power loss.`;
    },
    startCommand(): string {
      return `I'm online. Talk to me, send files, or try /status.`;
    },
  },
  turn: {
    working(): string {
      return `Working on it — tap to stop`;
    },
    waiting(kind: string): string {
      const label = kind.replace(/^job:/, '');
      return `Finishing ${label}, then I'll answer.`;
    },
    aborted(reason: string): string {
      return `Stopped that turn (${clipErr(reason, 120)}).`;
    },
    failed(error: string): string {
      return `That turn didn't finish: ${clipErr(error)}.`;
    },
  },
  proposal: {
    selfEdit(input: {
      id: number;
      target: 'persona' | 'lessons';
      why: string;
      whatChanges: string;
      evalSummary: string;
    }): { text: string; approveLabel: string; rejectLabel: string; diffCaption: string } {
      const where = input.target === 'persona' ? 'how I talk' : 'a lesson I keep';
      const text = [
        `I'd like to tweak ${where}.`,
        '',
        clipErr(input.why, 400),
        '',
        `What changes: ${clipErr(input.whatChanges, 400)}`,
        '',
        `Evals: ${input.evalSummary}`,
        '',
        `Approve or reject? (proposal ${input.id})`,
      ].join('\n');
      return {
        text,
        approveLabel: 'Approve',
        rejectLabel: 'Reject',
        diffCaption: `Diff for proposal ${input.id}`,
      };
    },
    telegramMap(input: {
      id: number;
      chatTitle: string;
      wikiProject: string;
      why: string;
    }): { text: string; keyboard: InlineKeyboard } {
      const text = [
        `I think the chat “${clip(input.chatTitle, 80)}” belongs with wiki/${input.wikiProject}/.`,
        '',
        clip(input.why, 240),
        '',
        `Want me to map it?`,
      ].join('\n');
      const keyboard = new InlineKeyboard()
        .text('Approve', `tgmap:ok:${input.id}`)
        .text('Reject', `tgmap:no:${input.id}`);
      return { text, keyboard };
    },
  },
  ops: {
    mailPipelineError(detail: string): string {
      return `Mail pipeline hit a snag: ${clipErr(detail, 300)}`;
    },
    mailStalled(lastFreshIso: string): string {
      return (
        `Mail export looks stalled — last fresh export was ${lastFreshIso.slice(0, 16)}. ` +
        `Is the daily export task still running?`
      );
    },
    archiveFailedToStart(detail: string): string {
      return `Couldn't start the Telegram archive: ${clipErr(detail)}`;
    },
    sendDocumentFailed(basename: string, detail: string): string {
      return `Couldn't send ${basename}: ${clipErr(detail)}`;
    },
    authFailed(detail: string): string {
      return (
        `⚠ Claude auth failed (${clipErr(detail, 120)}). The OAuth token is likely dead — ` +
        `run \`claude setup-token\`, paste the new token into icarus\\.env as CLAUDE_CODE_OAUTH_TOKEN, then /restart.`
      );
    },
    authCanaryFailed(detail: string): string {
      return (
        `⚠ Daily auth canary failed: ${clipErr(detail)}\n` +
        `If this repeats, run \`claude setup-token\`, paste into icarus\\.env, then /restart.`
      );
    },
    tokenAging(days: number): string {
      return `Heads up: the Claude OAuth token is ${days} days old — mint a fresh one soon (\`claude setup-token\`).`;
    },
    jobPrefix(name: string, body: string): string {
      return `${name}: ${body}`;
    },
  },
};
```

Note: confirm `clip` is exported from `src/telegram/ui.ts`. If not, inline a local clip helper instead of importing.

For `selfEdit`, callers currently pass separate `evidence` / `cause` / `predicted_impact`. In Task 2, compose `why` and `whatChanges` from those fields at the call site, e.g.:

```ts
why: `${evidence}\n\n${cause}`,
whatChanges: predicted_impact,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test tests/owner-voice.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/ownerVoice.ts tests/owner-voice.test.ts
git commit -m "Add ownerVoice module for secretary-tone owner DMs."
```

---

### Task 2: Migrate proposal and mapping copy

**Files:**
- Modify: `src/improve/proposals.ts` (summary construction ~108–124)
- Modify: `src/connectors/telegram/projectUi.ts` (re-export / thin wrap)
- Modify: `src/connectors/telegram/runtime.ts` only if import path changes (prefer keeping `renderProjectProposal` name as re-export)

**Interfaces:**
- Consumes: `ownerVoice.proposal.selfEdit`, `ownerVoice.proposal.telegramMap`
- Produces: `renderProjectProposal` still exported from `projectUi.ts` for existing imports

- [ ] **Step 1: Write / extend failing assertion** in `tests/owner-voice.test.ts` (or a small `tests/tg-project-ui.test.ts`) that imports `renderProjectProposal` and asserts no `Evidence:` / mapping-proposal header.

```ts
import { renderProjectProposal } from '../src/connectors/telegram/projectUi.js';

test('renderProjectProposal delegates to ownerVoice', () => {
  const r = renderProjectProposal({
    id: 9,
    chatTitle: 'Atlas',
    wikiProject: 'sodion-atlas',
    evidence: 'Discusses cell testing and atlas milestones.',
  });
  assert.doesNotMatch(r.text, /Evidence:/);
  assert.doesNotMatch(r.text, /Telegram\s*→\s*wiki mapping proposal/);
  assert.match(JSON.stringify(r.keyboard.inline_keyboard), /tgmap:ok:9/);
});
```

- [ ] **Step 2: Run focused test — expect FAIL** if `projectUi` still has old copy

Run: `npx tsx --test tests/owner-voice.test.ts`

- [ ] **Step 3: Rewrite `projectUi.ts`**

```ts
import { InlineKeyboard } from 'grammy';
import { ownerVoice } from '../../agent/ownerVoice.js';

export function renderProjectProposal(input: {
  id: number;
  chatTitle: string;
  wikiProject: string;
  evidence: string;
}): { text: string; keyboard: InlineKeyboard } {
  return ownerVoice.proposal.telegramMap({
    id: input.id,
    chatTitle: input.chatTitle,
    wikiProject: input.wikiProject,
    why: input.evidence,
  });
}
```

- [ ] **Step 4: Rewrite proposal DM in `proposals.ts`**

Replace the `summary` + keyboard block with:

```ts
import { ownerVoice } from '../agent/ownerVoice.js';

const copy = ownerVoice.proposal.selfEdit({
  id,
  target: input.target,
  why: `${input.evidence}\n\n${input.cause}`,
  whatChanges: input.predicted_impact,
  evalSummary,
});
const keyboard = new InlineKeyboard()
  .text(copy.approveLabel, `prop:${id}:approve`)
  .text(copy.rejectLabel, `prop:${id}:reject`);

if (diff.length <= 3500) {
  await sendOwnerKeyboard(`${copy.text}\n\n--- diff ---\n${diff}`, keyboard);
} else {
  const diffFile = path.join(cfg.proposalsDir, `proposal-${id}.diff.md`);
  writeFileSync(diffFile, `# Proposal #${id} diff\n\n\`\`\`diff\n${diff}\n\`\`\`\n`);
  await sendOwnerDocument(diffFile, copy.diffCaption);
  await sendOwnerKeyboard(copy.text, keyboard);
}
```

Keep the agent-facing return string (`proposal #${id} stored...`) as-is — that is not an owner DM.

- [ ] **Step 5: Run tests**

Run: `npx tsx --test tests/owner-voice.test.ts tests/tg-project-wiring.test.ts tests/tg-proposal-engine.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/improve/proposals.ts src/connectors/telegram/projectUi.ts tests/owner-voice.test.ts
git commit -m "Humanize self-edit and Telegram mapping proposal DMs."
```

---

### Task 3: Migrate remaining owner plumbing literals

**Files:**
- Modify: `src/main.ts`
- Modify: `src/telegram/bot.ts`
- Modify: `src/telegram/send.ts`
- Modify: `src/agent/runner.ts`
- Modify: `src/scheduler/jobs.ts`
- Modify: `src/connectors/mail.ts`

**Interfaces:**
- Consumes: `ownerVoice.online.*`, `ownerVoice.turn.*`, `ownerVoice.ops.*`

- [ ] **Step 1: Replace literals** (no new behavior)

Mappings:

| Location | Call |
|---|---|
| `main.ts` first-time | `ownerVoice.online.firstTime()` |
| `main.ts` recovered | `ownerVoice.online.recovered()` |
| `main.ts` waiting | `ownerVoice.turn.waiting(kind)` |
| `main.ts` archive fail | `ownerVoice.ops.archiveFailedToStart(String(e))` |
| `main.ts` `[name] body` prefix | `ownerVoice.ops.jobPrefix(name, body)` when wrapping |
| `bot.ts` working ephemeral | `ownerVoice.turn.working()` |
| `bot.ts` aborted | `ownerVoice.turn.aborted(res.error)` |
| `bot.ts` failed | `ownerVoice.turn.failed(res.error)` |
| `bot.ts` `/start` | `ownerVoice.online.startCommand()` |
| `send.ts` doc fail | `ownerVoice.ops.sendDocumentFailed(basename, String(e))` |
| `runner.ts` auth | `ownerVoice.ops.authFailed(detail)` |
| `jobs.ts` canary | `ownerVoice.ops.authCanaryFailed(String(e))` |
| `jobs.ts` token age | `ownerVoice.ops.tokenAging(Math.floor(days))` |
| `mail.ts` pipeline error | `ownerVoice.ops.mailPipelineError(String(e))` |
| `mail.ts` stalled | `ownerVoice.ops.mailStalled(last)` |

Leave agent/job body pass-through unchanged.

- [ ] **Step 2: Add a regression check** in `tests/owner-voice.test.ts` that imports nothing from those files but documents the expected strings via calling the same helpers (already covered in Task 1). Optionally grep in a tiny test:

```ts
test('banned ticket phrases are absent from ownerVoice surface', () => {
  const samples = [
    ownerVoice.online.firstTime(),
    ownerVoice.online.recovered(),
    ownerVoice.turn.failed('x'),
    ownerVoice.ops.mailPipelineError('x'),
  ].join('\n');
  assert.doesNotMatch(samples, /Evidence:/);
  assert.doesNotMatch(samples, /Self-edit proposal/);
});
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck`
Expected: clean

Run: `npx tsx --test tests/owner-voice.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/main.ts src/telegram/bot.ts src/telegram/send.ts src/agent/runner.ts src/scheduler/jobs.ts src/connectors/mail.ts tests/owner-voice.test.ts
git commit -m "Route owner status and ops DMs through ownerVoice."
```

---

### Task 4: Persona, lessons, scaffold, eval

**Files:**
- Modify: `persona/persona.md` (Chat style + Memory announce rule)
- Modify: `persona/lessons.md` (reconcile brevity lesson with conversational tone)
- Modify: `src/agent/persona.ts` (`DEFAULT_PERSONA` / `DEFAULT_LESSONS`)
- Create: `evals/cases/secretary-voice.json`

**Interfaces:**
- Consumes: voice contract from spec
- Produces: runtime persona text + eval case

- [ ] **Step 1: Add eval case**

```json
{
  "id": "secretary-voice",
  "prompt": "remind me what you filed last about the battery pack meeting",
  "rubric": "Sounds like a warm, crisp human assistant (not a chatbot or ticket system). No filler preamble (Certainly/Great question/As an AI). Answer-first, brief (under ~8 lines). Does not use Evidence:/Cause: style labels or markdown headers."
}
```

- [ ] **Step 2: Rewrite persona Chat style** to encode:
  - sharp EA register
  - speak vs quiet for filing
  - conversational approvals when the agent drafts ask-text
  - banned filler/ticket phrasing
  - keep Telegram plain-text + 3–6 line default + outbox rules

Rewrite Memory bullet: silent routine updates; mention only when worth knowing or needs a decision.

- [ ] **Step 3: Soften lessons** that force robot tone while keeping 3–6 lines and no markdown headers/bold.

- [ ] **Step 4: Mirror the same Chat style + Memory lines into `DEFAULT_PERSONA` in `persona.ts`.** Keep `DEFAULT_LESSONS` header compatible.

- [ ] **Step 5: Verify**

Run: `npm run typecheck`
Run: `npm run selftest`
Expected: `ok`

Run: `npm test`
Expected: green

- [ ] **Step 6: Commit**

```bash
git add persona/persona.md persona/lessons.md src/agent/persona.ts evals/cases/secretary-voice.json
git commit -m "Teach persona secretary voice and add voice eval."
```

---

## Plan self-review

- Spec coverage: module API, call-site table, persona/lessons, tests/evals, non-goals → Tasks 1–4.
- No TBD/placeholder steps.
- Callback payloads and `renderProjectProposal` name preserved for wiring stability.
- `clip` import: Task 1 notes fallback if export missing.
