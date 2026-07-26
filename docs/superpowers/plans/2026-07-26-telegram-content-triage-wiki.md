# Telegram Content Triage → Wiki Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace title-token chat→wiki mapping with LLM content judgment; live and historical triage turns filter noise, DM digests, auto-append durable facts to mapped telegram briefs, and Approve structural wiki changes.

**Architecture:** Add structured triage JSON parse + `WikiFactWriter`. Extend `TelegramTriageBridge` to apply facts/approvals after each turn. Replace sync `ProposalEngine.considerChat` title gate with LLM mapping suggestions from triage/historical turns. Add resumable `HistoricalPass` on import-complete and catch-up for already-imported unmapped chats.

**Tech Stack:** TypeScript ESM, existing `submitTurn` queue, `TelegramProjectStore`, `BriefWriter` paths, node:test.

**Spec:** `docs/superpowers/specs/2026-07-26-telegram-content-triage-wiki-design.md`

## Global Constraints

- `npm run typecheck` clean; `npm run selftest` prints `ok`; `npm test` green after every task.
- Single global agent lane — no new concurrency.
- Never write Desktop project folders — only `cfg.wikiDir` and `cfg.memoryDir`.
- Never auto-create wiki projects without Approve.
- Auto-append only to existing mapped `telegram-*.md` for this peer’s sticky project; spill only to projects that already have a `telegram-*.md`.
- Unmapped chats: digests OK; auto facts blocked; `mapping` → pending proposal DM only.
- Append-only migrations if any — prefer `tg_update_state` keys over new tables.
- Test files import `./env.js` first. Never commit `.env`, `state/`, `archive/`, real wiki content.
- Commits: plain imperative, no Claude attribution.
- Persona: allow auto-append to mapped telegram briefs; structural + first mapping still Approve-gated.

## File structure

| File | Responsibility |
|---|---|
| `src/connectors/telegram/triageOutput.ts` | Parse/validate structured triage JSON |
| `src/connectors/telegram/wikiFactWriter.ts` | Hybrid apply: append facts, queue approvals, enqueue mapping |
| `src/connectors/telegram/triage.ts` | Prompt + onDone wiring to parser/writer |
| `src/connectors/telegram/historicalPass.ts` | Import-complete / catch-up content+mapping turns |
| `src/connectors/telegram/proposalEngine.ts` | Remove title gate from considerChat; keep enqueue helpers / fingerprint |
| `src/connectors/telegram/runtime.ts` | Wire writer, historical pass, mapping notify |
| `src/connectors/telegram/projectSweep.ts` | Sweep enqueues historical/mapping turns not title match |
| `persona/persona.md` | Auto-append vs Approve rules |
| `tests/tg-triage-output.test.ts` | Parser tests |
| `tests/tg-wiki-fact-writer.test.ts` | Hybrid apply tests |
| `tests/tg-historical-pass.test.ts` | Historical trigger/resume tests |
| `tests/tg-triage.test.ts` | Update for structured onDone |

---

### Task 1: Structured triage output parser

**Files:**
- Create: `src/connectors/telegram/triageOutput.ts`
- Test: `tests/tg-triage-output.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ApprovalKind = 'new_page' | 'memory' | 'remap' | 'new_project';
  export interface TriageFact { project: string; claim: string; cite: number[]; why?: string }
  export interface TriageApproval { kind: ApprovalKind; summary: string; draft: string }
  export interface TriageMappingSuggestion {
    wikiProject: string; evidence: string; confidence: 'high' | 'medium' | 'low'
  }
  export interface TriageOutput {
    digest: string;
    mapping?: TriageMappingSuggestion;
    facts: TriageFact[];
    spill: TriageFact[];
    approvals: TriageApproval[];
    rawFallbackDigest?: string; // set when legacy prose-only
  }
  export type ParseTriageResult =
    | { ok: true; output: TriageOutput }
    | { ok: false; error: string };
  export function parseTriageOutput(finalText: string): ParseTriageResult;
  ```

- [ ] **Step 1: Write failing tests** in `tests/tg-triage-output.test.ts`

```ts
import './env.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTriageOutput } from '../src/connectors/telegram/triageOutput.js';

test('parses fenced JSON object', () => {
  const r = parseTriageOutput('```json\n{"digest":"","facts":[],"spill":[],"approvals":[]}\n```');
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.output.facts.length, 0);
});

test('empty JSON is silence', () => {
  const r = parseTriageOutput('{"digest":"","facts":[],"spill":[],"approvals":[]}');
  assert.equal(r.ok, true);
});

test('legacy prose becomes digest-only fallback', () => {
  const r = parseTriageOutput('▸ meeting · tomorrow 3pm');
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.output.digest, '▸ meeting · tomorrow 3pm');
    assert.equal(r.output.rawFallbackDigest, '▸ meeting · tomorrow 3pm');
  }
});

test('garbage fails', () => {
  const r = parseTriageOutput('{not json');
  assert.equal(r.ok, false);
});

test('unknown project slug kept but fact claim required', () => {
  const r = parseTriageOutput(JSON.stringify({
    digest: '',
    facts: [{ project: 'nope', claim: 'x', cite: [1] }],
    spill: [],
    approvals: [],
  }));
  assert.equal(r.ok, true);
});
```

- [ ] **Step 2: Run tests — expect FAIL** (`parseTriageOutput` missing)

Run: `npm test -- tests/tg-triage-output.test.ts`

- [ ] **Step 3: Implement `triageOutput.ts`**

Extract JSON from fenced block or first `{...}` object. Validate with zod (already in deps). Missing arrays default to `[]`. Non-JSON non-empty text → ok with digest-only fallback. Empty string → ok empty silence. `{not json` or empty object that is invalid JSON after extract → fail.

- [ ] **Step 4: Run tests — expect PASS**

- [ ] **Step 5: Commit** `Add structured telegram triage output parser.`

---

### Task 2: WikiFactWriter

**Files:**
- Create: `src/connectors/telegram/wikiFactWriter.ts`
- Modify: `src/connectors/telegram/briefWriter.ts` (export `assertSafeWikiPath` or duplicate thin append helper)
- Test: `tests/tg-wiki-fact-writer.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface WikiFactWriterDeps {
    wikiDir: string;
    projects: TelegramProjectStore;
    archive: TelegramArchiveStore;
    wikiProjectSlugs: () => string[]; // from listWikiProjects
  }
  export interface ApplyTriageResult {
    digest: string;
    mappingProposal: ProjectProposal | null;
    appended: number;
    approvalNotices: string[]; // owner DM bodies for structural items
    alerts: string[];
  }
  export class WikiFactWriter {
    constructor(deps: WikiFactWriterDeps);
    apply(peerKey: string, output: TriageOutput): ApplyTriageResult;
  }
  ```

Rules to encode exactly:
1. If unmapped + `output.mapping` with known slug → `enqueueProposal` (fingerprint sha256 of slug+evidence slice); return proposal.
2. Auto `facts`: only if `projects.getMapping(peerKey)`; append to that mapping’s `briefPath` as `- claim — cite links`.
3. Auto `spill`: only if target slug known AND `listMappingsForProject(target)` has ≥1 brief; append to first brief path (or newest); else push approval notice `new_page`.
4. Unknown slug on fact/spill/mapping → approval notice `new_project` (or skip mapping enqueue).
5. `output.approvals` → approval notice strings (no file writes).
6. Never touch MEMORY.md here.

- [ ] **Step 1: Failing tests** covering mapped append, unmapped blocks facts, spill unknown→approval, mapping enqueue without title match

- [ ] **Step 2: Implement writer + `appendFactsToBrief(briefRel, facts)` in briefWriter or writer**

Append under `## Notes` section (create section if missing). Cite as `peerKey#messageId` when deep link unavailable.

- [ ] **Step 3: Tests PASS + typecheck**

- [ ] **Step 4: Commit** `Add WikiFactWriter for hybrid telegram wiki updates.`

---

### Task 3: Wire triage bridge

**Files:**
- Modify: `src/connectors/telegram/triage.ts`
- Modify: `src/connectors/telegram/runtime.ts`
- Modify: `tests/tg-triage.test.ts` (if prompt/onDone expectations break)

**Interfaces:**
- Extends `TelegramTriageBridge` deps with optional:
  ```ts
  applyOutput?: (peerKey: string, output: TriageOutput) => ApplyTriageResult | Promise<ApplyTriageResult>;
  notifyMapping?: (proposal: ProjectProposal) => Promise<void>;
  notifyApprovals?: (texts: string[]) => Promise<void>;
  listWikiProjects?: () => { slug: string; title: string }[];
  getMapping?: (peerKey: string) => { wikiProject: string; briefPath: string } | undefined;
  ```
- Prompt changes: instruct model to reply with **only** the JSON schema from the spec (plus DIGEST_STYLE for the `digest` field content). Include sticky mapping if present and wiki project list. Include title-token hint optional one-liner if `matchChatToProjects` returns something (hint only).

- [ ] **Step 1: Update `buildTriagePrompt` and `onDone`**

`onDone` when status ok:
1. `parseTriageOutput(result.finalText)`
2. if !ok → record failure path (existing)
3. if ok → `applyOutput` if provided; send `digest` if non-empty; notify mapping; notify approval texts; send alerts
4. if legacy fallback digest only and no applyOutput side effects beyond digest — fine

- [ ] **Step 2: Wire in `runtime.ts` create()**

- [ ] **Step 3: Tests + typecheck PASS**

- [ ] **Step 4: Commit** `Wire structured triage output into live telegram bridge.`

---

### Task 4: Historical pass + replace title-gate proposals

**Files:**
- Create: `src/connectors/telegram/historicalPass.ts`
- Modify: `src/connectors/telegram/proposalEngine.ts` — `considerChat` becomes thin helper used only if LLM already produced a MatchResult-like object OR remove title matching from import path
- Modify: `src/connectors/telegram/runtime.ts` — `onImportComplete` starts historical pass
- Modify: `src/connectors/telegram/projectSweep.ts` / scheduler fire path — enqueue historical/mapping for unmapped selected chats
- Test: `tests/tg-historical-pass.test.ts`

**Interfaces:**
```ts
export class TelegramHistoricalPass {
  constructor(deps: {
    store: TelegramArchiveStore;
    query: TelegramArchiveQuery;
    submit: typeof submitTurn;
    applyOutput: (peerKey: string, output: TriageOutput) => ApplyTriageResult;
    notifyDigest: (text: string) => Promise<void>;
    notifyMapping: (p: ProjectProposal) => Promise<void>;
    notifyApprovals: (texts: string[]) => Promise<void>;
    listWikiProjects: () => WikiProject[];
    getMapping: (peerKey: string) => ProjectMapping | undefined;
  });
  /** Start or resume pass for peer. Idempotent if complete. */
  enqueue(peerKey: string): void;
  /** Catch-up: all selected chats without historical-pass:done state */
  enqueueCatchUp(): void;
}
```

State keys in `tg_update_state`:
- `historical-pass:{peerKey}` value JSON `{ phase: 'mapping'|'content'|'done', cursorMessageId?: number, digestParts: string[] }`

Behavior:
1. `enqueue` submits `job:tg-historical:<sanitized>` with prompt covering newest window + FTS hits for wiki slugs; same JSON schema; mention this is historical import pass.
2. onDone: parse → apply → accumulate digest; advance cursor; if more windows, re-enqueue; else send one combined digest DM and mark done.
3. `onImportComplete` calls `historicalPass.enqueue(peerKey)` instead of `proposalEngine.considerChat`.
4. Sweep: call `enqueue` for unmapped selected chats lacking pending proposal (and not recently rejected same fingerprint — fingerprint comes after LLM returns).
5. Keep `matchChatToProjects` exported for unit tests / optional hint in prompts only.
6. `ProposalEngine.considerChat` either deleted from import path or repurposed to `enqueueFromSuggestion(peerKey, suggestion)` used by WikiFactWriter.

- [ ] **Step 1: Tests for enqueue sets state and submit called; resume after partial cursor**

- [ ] **Step 2: Implement + wire runtime start() to `enqueueCatchUp()` once**

- [ ] **Step 3: Update sweep to use historicalPass**

- [ ] **Step 4: PASS tests/typecheck/selftest**

- [ ] **Step 5: Commit** `Add historical telegram content pass and LLM mapping triggers.`

---

### Task 5: Persona + approval DM copy + final verification

**Files:**
- Modify: `persona/persona.md` (Telegram archive section)
- Possibly `projectUi.ts` if approval notices need keyboards later — v1 plain DM text for structural approvals is OK; mapping keeps Approve/Reject keyboard

Persona bullets:
- Auto-append durable facts to mapped `wiki/<project>/telegram-*.md` is allowed from tg-triage / historical jobs.
- Still never write MEMORY.md Telegram pointers, new wiki pages, remaps, or new projects without Approve.
- Triage final reply must be the JSON contract (digest inside JSON).

- [ ] **Step 1: Update persona**

- [ ] **Step 2: Run full `npm test`, `npm run typecheck`, `npm run selftest`**

- [ ] **Step 3: Commit** `Allow mapped telegram brief auto-appends in persona.`

---

## Spec coverage check

| Spec requirement | Task |
|---|---|
| LLM mapping not title gate | 4 |
| Hybrid auto facts / Approve structural | 2, 3 |
| Sticky + spill | 2 |
| Historical mapping+facts+digest | 4 |
| Noise = empty output | 1, 3 |
| Unmapped digests OK, facts blocked | 2 |
| Weekly sweep LLM path | 4 |
| Parse failure handling | 1, 3 |
| No embeddings / no auto-create projects | 2 |
| Persona/guard | 5 |

## Execution

Use subagent-driven-development on branch `feature/tg-content-triage-wiki`. Merge to `main` when all tasks pass. After merge: restart Icarus (`/restart` or service restart), send owner test DM, delete stray untracked junk (`evals/cases/fb3.json` if leftover, no `state/`/`archive/` commits).
