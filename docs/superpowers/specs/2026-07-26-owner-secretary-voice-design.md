# Owner secretary voice — design

Date: 2026-07-26
Status: approved for implementation

## Purpose

Icarus currently sounds like a ticket system and a chatbot: persona pushes silent
writes and template-y lists, and TypeScript invents stiff owner DMs
(`Self-edit proposal #12`, `Evidence:`, `turn failed:`). Jeon wants every surface
— chat replies, status lines, filings that matter, and Approve/Reject asks — to
feel like a sharp executive assistant speaking natural language.

## Goals

- One shared **voice contract**: warm, crisp, human secretary — not AI filler,
  not system-log tone.
- Agent turns follow the contract via `persona/persona.md` and `persona/lessons.md`.
- All fixed owner-facing copy lives in one module (`src/agent/ownerVoice.ts`) so
  plumbing DMs cannot invent ticket-speak.
- Proposal/approval DMs are conversational: why it matters → tiny what-changes →
  Approve/Reject buttons (same callbacks as today).
- Routine filing/memory/wiki housekeeping stays silent; speak only when worth
  knowing or a decision is needed.
- Keep brevity for agent chat (~3–6 lines default). Digests stay compact and
  scannable under the same human voice.

## Non-goals

- LLM-rewriting system messages at send time.
- i18n, localization, or a generic copy/CMS framework.
- Changing Approve/Reject callback payloads or proposal persistence.
- Changing digest *structure* contracts beyond tone (urgent-first, line budget,
  silence-valid remain).
- Rewriting agent-authored free text after the model produces it (persona only).
- Voice notes / TTS.

## Decisions (from brainstorm)

| Topic | Choice |
|---|---|
| Scope | Everywhere (chat, status, approvals) |
| Register | Warm but crisp — sharp EA, no wasted words |
| Filing | Silent on routine; mention when worth knowing or needs a decision |
| Approvals | Fully conversational lead-in; keep buttons |
| Delivery | Shared owner-voice module + persona rewrite (Approach 3) |

## Architecture

```
persona.md / lessons.md     → agent DM replies (model)
src/agent/ownerVoice.ts     → plumbing DMs (TypeScript templates)
         │
         ▼
    same voice contract
```

Call sites keep using `sendOwner` / `sendOwnerKeyboard` / `sendOwnerEphemeral` /
`sendOwnerDocument`. They stop embedding ticket-style string literals; they call
`ownerVoice.*` helpers that return the text (and, for proposals, keyboard labels
when those change).

No runtime “tone layer” between agent output and Telegram. Consistency for
agent turns is prompt discipline + evals; consistency for plumbing is the module.

## Voice contract

**Role:** sharp executive assistant — warm, crisp, human.

**Defaults**
- Lead with the answer or the ask in the first sentence.
- Short natural sentences. Agent chat default remains ~3–6 lines unless detail
  was requested.
- Plain Telegram text: no markdown headers/tables; light structure only when it
  helps scanning.
- No AI filler (“Certainly!”, “Great question!”, “As an AI…”, restating the ask).

**Speak vs quiet**
- Routine filing / memory / wiki housekeeping → silent.
- Worth knowing, surprising, or needs a decision → one short human line
  (question optional).
- Proposals / approvals → always conversational.

**Proposal shape (all approval DMs)**
1. Why this matters (plain English, 1–2 sentences).
2. Tiny what-changes (what Jeon is approving, not a field dump).
3. Inline keyboard: Approve / Reject (callback data unchanged).

**Anti-patterns (banned in ownerVoice and discouraged in persona)**
- Label dumps: `Evidence:`, `Cause:`, `Predicted impact:`, `Self-edit proposal #N`.
- Status-log tone: `turn failed:`, parenthetical crash recovery essays.
- Announcing every silent write.

**Digests:** keep urgent-first, one-line skim helpers (`▸` allowed), 15-line
budget, silence valid. Prefer human phrasing inside those constraints; do not
invent a second robot dialect.

## Module API

**File:** `src/agent/ownerVoice.ts`

Pure functions returning strings (or `{ text, keyboard }` where a site already
returns both). Exact export surface:

```ts
export const ownerVoice = {
  online: {
    firstTime(): string;
    recovered(): string;
    startCommand(): string;
  },
  turn: {
    working(): string;           // ephemeral stop affordance
    waiting(kind: string): string;
    aborted(reason: string): string;
    failed(error: string): string;
  },
  proposal: {
    selfEdit(input: {
      id: number;
      target: 'persona' | 'lessons';
      why: string;          // from evidence+cause, already humanized by caller or composed here
      whatChanges: string;  // short plain summary; full diff attached separately when long
      evalSummary: string;
    }): { text: string; approveLabel: string; rejectLabel: string; diffCaption: string };
    telegramMap(input: {
      id: number;
      chatTitle: string;
      wikiProject: string;
      why: string;
    }): { text: string; keyboard: InlineKeyboard }; // keyboard callbacks unchanged
  },
  ops: {
    mailPipelineError(detail: string): string;
    mailStalled(lastFreshIso: string): string;
    archiveFailedToStart(detail: string): string;
    sendDocumentFailed(basename: string, detail: string): string;
    authFailed(detail: string): string;
    authCanaryFailed(detail: string): string;
    tokenAging(days: number): string;
    jobPrefix(name: string, body: string): string; // human wrap for `[name] body` if needed
  },
};
```

Rules for the module:
- Never emit `Evidence:`, `Cause:`, `Self-edit proposal`, or `Telegram → wiki mapping proposal` headers.
- Clip long details the same way call sites do today (reuse existing clip helpers where present).
- Keep callback data identical (`prop:${id}:approve`, `tgmap:ok:${id}`, etc.).

`src/connectors/telegram/projectUi.ts` either becomes a thin re-export of
`ownerVoice.proposal.telegramMap` or is deleted after call sites move.

## Call-site migration (in scope)

| Site | Today | After |
|---|---|---|
| `src/main.ts` | first-time / recovered / finishing / archive fail | `ownerVoice.online.*`, `turn.waiting`, `ops.archiveFailedToStart` |
| `src/telegram/bot.ts` | working…, abort, turn failed, `/start` | `turn.*`, `online.startCommand` |
| `src/improve/proposals.ts` | Evidence/Cause template | `proposal.selfEdit` |
| `src/connectors/telegram/projectUi.ts` | Chat/Wiki/Evidence labels | `proposal.telegramMap` |
| `src/telegram/send.ts` | sendDocument failure | `ops.sendDocumentFailed` |
| `src/agent/runner.ts` | auth failed alert | `ops.authFailed` |
| `src/scheduler/jobs.ts` | canary / token age | `ops.authCanaryFailed`, `ops.tokenAging` |
| `src/connectors/mail.ts` | pipeline error / stalled | `ops.mailPipelineError`, `ops.mailStalled` |

## Out of scope for migration

- Agent final reply text (persona + evals).
- Digest body content produced by triage turns (persona + `digestStyle` guide).
- Pass-through of already-composed job/agent text (`onText`, schedule bodies with
  meaningful content) — only the wrapper prefix, if any, goes through ownerVoice.
- Telegram archive UI pages, dialog browsers, and other interactive UIs that are
  not “secretary speaking to Jeon about work” (leave unless a string is clearly
  an owner status line in the migration table).

## Persona / lessons changes

Rewrite `## Chat style` (and related lines) in `persona/persona.md` to encode the
voice contract: warm-crisp secretary, speak-vs-quiet, conversational approvals,
banned filler/ticket phrasing.

Change memory guidance from “Don't announce it; just do it” to: do routine
memory/wiki updates silently; mention only when worth knowing or a decision is
needed.

Update `persona/lessons.md` only where an existing lesson fights the new voice
(e.g. over-rigid formatting that forces robot tone). Keep the brevity lesson’s
3–6 line target and plain-text rule; reconcile wording so brevity ≠ robotic.

Also update the scaffolded defaults in `src/agent/persona.ts` (`DEFAULT_PERSONA` /
`DEFAULT_LESSONS`) so fresh installs match.

## Testing

- Unit tests for `ownerVoice` proposal/mapping/ops strings: assert conversational
  shape and assert absence of banned labels (`Evidence:`, `Self-edit proposal`,
  `turn failed:` as a prefix pattern, etc.).
- Update existing tests that assert old proposal/mapping copy
  (e.g. project UI / proposal wiring tests).
- New eval case under `evals/cases/`: everyday Q&A reply has no chatbot preamble
  and does not read like a ticket; still brief and answer-first.
- `npm run typecheck` clean; `npm run selftest` prints `ok`; relevant `npm test`
  paths green.

## Error handling

Ops/error copy stays honest and actionable, but human: say what happened and
what Jeon can do next, without stack-dump tone. Truncation of error detail
remains (existing slice lengths). Auth/canary alerts keep urgency markers if
useful (`⚠` ok) but drop robot phrasing.

## Rollout

Single PR/branch change set: module + migrations of listed call sites + persona
+ tests/evals. No feature flag. Persona change takes effect on next agent turn
(`/restart` only needed for `src/` edits per project norms).

## Success criteria

- Opening a mapping or self-edit approval DM reads like a person asking for a
  decision, not a form.
- Boot/abort/error lines sound like the same person.
- Agent chat still brief; no surge in AI-filler eval failures.
- New owner-facing string in listed sites cannot land without going through
  `ownerVoice` (enforced by review + tests on the helpers; no runtime lint
  required in v1).
