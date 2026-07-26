# Telegram content triage → wiki — design

Date: 2026-07-26
Status: approved for implementation planning
Amends:
- `docs/superpowers/specs/2026-07-26-telegram-project-synthesis-design.md` (phase 3)
Amended by:
- `docs/superpowers/specs/2026-07-26-project-raw-shelf-design.md` — runtime may write
  only `Desktop/<project>/raw/` on intentional ingest; triage LLM still does not write
  Desktop project trees
Depends on:
- `docs/superpowers/specs/2026-07-25-telegram-archive-foundation-design.md` (phase 1)
- `docs/superpowers/specs/2026-07-26-telegram-archive-retrieval-design.md` (phase 2)

## Purpose

Replace title/username token matching as the chat→wiki mapper with **LLM judgment over
chat contents**. After a sticky mapping exists, live triage (and a one-shot historical
pass) must **filter noise**, optionally **DM a digest**, **auto-append durable facts** to
the mapped telegram brief, and **propose structural wiki changes** for Approve/Reject.

Phase 3 already ships Approve/Reject mapping DMs, `tg_project_*` tables, and
locator-style briefs. This design keeps that confirm UX and storage, but changes *how*
mappings are proposed and *when* briefs grow after approval.

## Problem

Import-complete mapping only fires when the chat title/username strongly overlaps a wiki
project slug/title (`general`, `morianlabs`, `sodion-atlas`). Chats whose **contents**
are project-relevant but whose **names** are not (e.g. trip planning, vendor threads)
produce `proposals: []`. Live triage DMs digests but does not keep wiki briefs current.
Noise is common; silence must remain the default.

## Goals

- Propose sticky `selected chat → existing wiki project` mappings from **message content**
  (links, media paths, claims), not chat title alone.
- On import complete (and for already-imported unmapped selected chats): run a historical
  content pass that proposes mapping, extracts durable facts (hybrid rules), and sends one
  owner digest DM summarizing what was found.
- On live arrivals: reuse the existing quiet-window / burst triage bridge; each turn may
  digest, auto-append facts, spill strongly evidenced facts to another mapped project, or
  enqueue structural Approve DMs.
- Filter junk: empty structured output = silence; do not spam digests or wiki writes.
- Hybrid writes:
  - **Auto:** durable facts (dates, links, decisions, named entities, file refs) appended
    to an existing `wiki/<project>/telegram-*.md`.
  - **Approve required:** new wiki pages, `MEMORY.md` changes, remapping, “this is a new
    project”.
- Sticky mapping with **cross-project spill** when evidence is strong; spill does not
  create a brief for an unmapped chat.
- Keep locator-style cites (peer + message id / deep link); no transcript dumps into wiki.
- Never write outside `wiki/` and the Icarus memory directory. The triage **LLM** never
  writes Desktop project folders; the separate raw-shelf **runtime** may write only
  `Desktop/<project>/raw/` on intentional ingest (see project-raw-shelf design).

## Non-goals

- Embedding / clustering stack for mapping.
- Auto-creating wiki projects without Approve.
- Triage LLM writing into Desktop project folders (raw-shelf runtime is out of scope here).
- Re-running full-history digests on every process restart.
- Changing phase 1 sync semantics (archive remains read-only on the personal account).
- Replacing Approve/Reject for first sticky mapping and for structural ops.
- Browser MCP on tg-triage (calendar MCP may remain available as today).

## Decisions (locked in brainstorming)

| Topic | Choice |
|---|---|
| Scope | Mapping + live wiki updates + noise filter (not mapping-only) |
| Write gate | Hybrid: durable facts auto; structural Approve |
| Routing | Sticky mapping + strong spill |
| Hybrid line | Auto facts; Approve for new page / MEMORY / remap / new project |
| Historical | Mapping + fact extraction + owner digest DM |
| Approach | Extend live triage agent turns (one LLM path) |

## Architecture

```
Import complete / unmapped catch-up
        │
        ▼
  LLM mapping turn  ──► sticky proposal DM (Approve/Reject)
        │                   └─ approve: telegram-*.md + MEMORY pointer (existing path)
        ▼
Live quiet/burst  OR  one-shot historical pass (sampled windows)
        │
        ▼
  LLM triage turn (structured)
        ├─ noise → silence
        ├─ digest → owner DM
        ├─ durable facts → auto-append mapped brief (+ strong spill)
        └─ structural → Approve DM (no write until Approve)
```

Archive sync stays outside the agent lane. Triage still uses per-chat queue jids
(`job:tg-triage:<peer>`). Historical content digest is an **explicit exception** to the
phase 1 note that backfill never digests: backfill still does not mark `triage_pending`
for the live watermark path; the historical pass is a separate, resumable job.

### Components

`ProposalEngine`
: Stop using title-token `matchChatToProjects` as the proposal gate. Keep
  enqueue/fingerprint/Approve/Reject integration with `TelegramProjectStore`. Mapping
  candidates come from an LLM mapping turn. Optional title-token overlap may appear in the
  prompt as a **hint**, never as a veto.

`TelegramTriageBridge`
: Keep quiet window (5 min), burst cap (50), flush timer, failure streak DMs. Change the
  prompt and `onDone` handling to parse structured output and hand facts/approvals to
  `WikiFactWriter` instead of only forwarding `finalText`.

`WikiFactWriter` (new)
: Applies hybrid rules. Auto-appends durable facts to existing telegram briefs under
  allowed project paths. Converts unknown spill targets and structural ops into pending
  approval items (owner DMs). Never freestyle-edits arbitrary wiki files.

`HistoricalPass` (new trigger)
: After import complete, and once for already-imported unmapped selected chats: mapping
  turn if needed, then one or more capped content windows (recent + FTS-salient), then a
  single digest DM. Progress cursor in `tg_update_state` so restarts resume.

`BriefWriter`
: Unchanged Approve path for first brief + MEMORY pointer. Auto path only **appends**
  bullets with cites after a mapping and brief exist.

Guard / persona
: Allow auto-append to mapped `telegram-*.md` briefs. Structural wiki/MEMORY writes and
  first mapping still require owner Approve.

## Structured triage output

Parsed from the agent’s final reply (JSON object). Optional human digest is a field, not
unstructured freeform as the sole contract.

```json
{
  "digest": "optional short owner DM, or empty",
  "mapping": {
    "wikiProject": "morianlabs",
    "evidence": "why this sticky mapping",
    "confidence": "high|medium|low"
  },
  "facts": [
    { "project": "morianlabs", "claim": "...", "cite": [123, 124] }
  ],
  "spill": [
    { "project": "sodion-atlas", "claim": "...", "cite": [130], "why": "..." }
  ],
  "approvals": [
    {
      "kind": "new_page|memory|remap|new_project",
      "summary": "...",
      "draft": "..."
    }
  ]
}
```

`mapping` is only actionable when the chat is unmapped (or an approval of kind `remap`
is present). Low-confidence mapping may still enqueue a proposal; reject fingerprinting
prevents nag loops.

### Apply order (successful turn)

1. If unmapped and `mapping` present → enqueue pending proposal + Approve/Reject DM
   (existing UI). Do not auto-write the brief until Approve.
2. Auto-append `facts` for this peer only to **this peer’s** approved
   `wiki/<sticky-project>/telegram-*.md`. Auto-append `spill` only when the target
   project already has at least one existing `telegram-*.md` brief; otherwise convert to
   an approval (`new_page` / wait for mapping). Never invent wiki folders or briefs
   casually.
3. Queue `approvals` as owner DMs; apply only on Approve.
4. Send `digest` only if non-empty.

### Unmapped live chats

Digests remain allowed. Auto wiki facts are blocked until sticky mapping is approved.
Spill alone cannot create a brief for this chat.

### Noise

Default output is empty. Heuristic `isLowSignal` may annotate or de-prioritize lines in
the prompt window; it must not drop an entire batch before the LLM sees context (a noisy
batch can still contain one durable fact).

## Historical pass details

- Trigger: `onImportComplete`, plus a one-shot catch-up for selected chats that finished
  import earlier with no mapping/facts pass.
- Does not set live `triage_pending` on all backfill rows.
- Windows: newest N messages + FTS hits for wiki project tokens / salient terms; multiple
  turns if needed, each capped like live triage (`MAX_BATCH`).
- Ends with at most one digest DM for the pass (not one per window), unless a window
  surfaces urgent calendar-worthy items (same calendar MCP rules as live triage).
- Resumable via `tg_update_state` key such as `historical-pass:{peerKey}`.

## Weekly sweep

`tg-project-sweep` keeps scanning unmapped selected chats, but asks for an LLM mapping
consideration (or enqueues a mapping turn) instead of title-token scoring. Rejected
fingerprints still suppress re-prompt until evidence fingerprint changes materially.

## Failure handling

- Unparseable JSON: if `finalText` looks like a legacy digest-only reply, send digest and
  skip wiki side effects; otherwise fail the turn (existing triage failure streak + one
  DM). No partial wiki writes from garbage output.
- Auto-append failure (missing brief, path escape): skip that fact, one alert; do not
  block digest delivery.
- Spill / fact targeting unknown project slug → convert to `approvals` (`new_project` or
  clarify); never mkdir a new wiki project folder without Approve.
- Mapping rejected → store rejection; no auto-reprompt until sweep fingerprint change or
  explicit rematch.
- Historical pass interrupted → resume from cursor; import-complete status DM still fires
  independently.

## Testing

### Unit

- Structured-output parser (valid, digest-only fallback, garbage → fail).
- Hybrid apply: facts append; structural stays pending; unknown slug → approval.
- Unmapped peer: digest ok; auto facts blocked.
- Mapping proposal enqueued from LLM suggestion without title token overlap.
- Spill to project without brief → approval, not silent file create.

### Integration (fakes)

- Import-complete → mapping DM for content-relevant untitled chat.
- Live junk batch → silence (no DM, no wiki write).
- Live durable fact on mapped chat → brief append with cite.
- Structural suggestion → Approve DM only until approved.
- Historical pass resume after simulated interrupt.

### Regression

- Existing quiet-window / burst / failure-alert triage tests stay green.
- Approve/Reject mapping + MEMORY single-line discipline from phase 3 remains.

## Acceptance criteria

- Chats like trip/vendor threads with project-relevant contents can receive a mapping
  proposal without title overlap.
- Import historical pass yields mapping (when warranted), fact extraction under hybrid
  rules, and one digest DM.
- Live triage filters noise by default; durable facts update telegram briefs; structural
  changes require Approve.
- Sticky mapping + strong spill behave as specified; unmapped chats do not auto-write wiki.
- No embeddings; no auto-create projects; wiki/memory path safety preserved.
- `npm run typecheck` clean; `npm run selftest` ok; new tests cover the above.

## Ordering

1. Structured output schema + parser + `WikiFactWriter` (auto vs approval).
2. Wire into `TelegramTriageBridge.onDone` and prompt; keep digest DM behavior.
3. Replace ProposalEngine title gate with LLM mapping turn; keep store/UI.
4. Historical pass on import complete + catch-up for already-imported chats.
5. Update weekly sweep; persona/guard copy; tests and manual acceptance.

## Relationship to phase 3 spec

Where this document conflicts with
`2026-07-26-telegram-project-synthesis-design.md`, **this document wins** for:

- how mapping candidates are chosen (LLM content vs title tokens);
- whether briefs may grow after initial approve (yes, via auto-append + approvals);
- whether historical content may produce a digest (yes, via HistoricalPass).

Phase 3 storage, Approve/Reject UX, locator brief paths, and MEMORY one-line discipline
remain in force unless explicitly changed above.
