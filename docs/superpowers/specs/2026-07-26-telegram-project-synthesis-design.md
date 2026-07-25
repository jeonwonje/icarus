# Telegram project synthesis — design (phase 3)

Date: 2026-07-26
Status: approved for implementation
Depends on:
- `docs/superpowers/specs/2026-07-25-telegram-archive-foundation-design.md` (phase 1)
- `docs/superpowers/specs/2026-07-26-telegram-archive-retrieval-design.md` (phase 2)

## Purpose

Map selected Telegram chats to existing wiki projects, only after Jeon explicitly
approves each proposal, then write locator-style project briefs in the wiki and a single
pointer line per project in `MEMORY.md`.

This is phase 3 of the three-phase program. Retrieval stays in phase 2. Synthesis never
runs until mappings are confirmed.

## Goals

- Propose `selected chat → existing wiki project` mappings with evidence.
- Trigger proposals after import completion (when a likely match exists) and via a
  periodic sweep of remaining unmapped selected chats.
- Require explicit approve/reject in the owner DM before any wiki or memory write.
- On approve: persist the mapping, write/update a wiki brief under that project, and add
  exactly one `MEMORY.md` line (title + wiki path).
- Keep briefs locator-style: claims cite archive messages (deep link / peer+message id);
  do not dump whole chats into the wiki.
- Leave low-signal social content searchable (phase 2) but out of briefs by default.
- Reuse `TelegramArchiveQuery` for any archive reads during proposal or brief drafting.

## Non-goals

- Auto-creating new wiki projects (v1 matches existing projects from `wiki/index.md` only).
- Writing into Desktop project folders (`../morianlabs/`, etc.) — wiki only, per wiki schema.
- Copying full Telegram histories into wiki pages.
- Bloated `MEMORY.md`: never paste facts there; one line per confirmed project.
- Re-proposing the same rejected chat on every sweep without a material change or an
  explicit owner request.
- Changing phase 1 sync or phase 2 citation rules.
- Embedding-based project clustering.

## Current state

Phase 1 archives selected chats. Phase 2 (designed) exposes search/window with citations.
The Desktop wiki (`wiki/`) catalogs projects 1:1 with folders; sources are locators, not
copies. Telegram used to be treated as unretrievable capture; with the local archive and
deep links, Telegram evidence becomes retrievable and briefs should point at it rather
than paste transcripts. `MEMORY.md` is injected every turn and must stay small.

## Architecture

```
import complete / periodic sweep
        │
        ▼
 ProposalEngine ──► pending proposal (SQLite) ──► owner DM approve/reject
        │                                              │
        │                                         approve only
        ▼                                              ▼
 TelegramArchiveQuery                    mapping row + wiki brief + MEMORY line
```

### Components

`TelegramProjectStore`
: SQLite tables for mappings and proposals. Append migrations in `src/db.ts` only.

`ProposalEngine`
: Scores unmapped selected chats against existing wiki projects. v1 matching is
  deterministic and cheap: normalize chat title/username tokens against wiki project
  folder names and titles from `wiki/index.md`; require at least one strong token overlap
  (project slug or distinctive multi-character token). Optional sampled messages via
  `TelegramArchiveQuery` may reinforce a candidate but cannot invent projects outside the
  wiki index. Enqueues at most one pending proposal per chat.

`ProjectMappingUI`
: Owner-DM approve/reject buttons (and a short evidence blurb). Reject and approve are
  durable decisions.

`BriefWriter`
: On approve, writes/updates a wiki page under the target project and maintains the single
  `MEMORY.md` pointer line. Never writes outside `wiki/` and the Icarus memory directory.

### Data model (logical)

- `tg_project_mappings`: `peer_key` → `wiki_project` (kebab name matching wiki folder),
  `approved_at`, `brief_path`, optional notes.
- `tg_project_proposals`: `peer_key`, suggested `wiki_project`, evidence summary, score,
  `state` (`pending` | `approved` | `rejected`), timestamps, `sweep_generation` / fingerprint
  so rejects are not re-spammed.

Only selected chats may appear. Unmapped is the default.

### Proposal triggers

1. **After import completes** — if the chat is unmapped and a match clears a confidence
   floor, enqueue one pending proposal and send one owner DM (or attach to an existing
   pending notification without duplicating).
2. **Periodic sweep** — system schedule reviews unmapped selected chats, proposes likely
   matches, skips chats with a recent reject unless the evidence fingerprint changed
   materially or Jeon asks to rematch.

No background wiki writes. Proposals are inert until approve.

### Confirm UX

- Explicit **Approve** / **Reject** on the proposal message.
- Approve applies mapping + brief + memory line.
- Reject stores rejection; leaves chat unmapped and searchable; no wiki/memory write.
- No inline project rename/retarget in v1 (chosen confirm style was approve/reject only).
  Wrong suggestion → reject; a later explicit “map this chat to X” can be a follow-on if
  needed.

### Wiki briefs

- Path: `wiki/<project>/telegram-<chat-slug>.md` (flat kebab-case; one brief page per
  approved chat mapping). If that filename already exists, update it in place.
- Content: short claims about the project derived from that mapped chat, each claim
  backed by archive citations (deep link or peer+message id + date).
- Follow wiki schema: locators over copies; do not create a `sources/` directory; do not
  write into Desktop project repos. Because the local archive makes Telegram retrievable,
  briefs point at messages rather than pasting transcripts.
- Low-signal social content (memes, banter with no project claim) stays out by default.
- Refresh: not on every live message. v1 writes/updates the brief only on approve (and on
  an explicit owner rematch/refresh request if added). No automatic scheduled rewrite.

### MEMORY.md discipline

- Exactly one line per confirmed wiki project that has at least one approved Telegram
  mapping.
- Line format: project title + wiki path only (no facts, no quotes, no chat dumps).
- Updating a brief does not add more memory lines.
- Unmapping / removing a chat mapping updates or removes the line only when no mappings
  remain for that project.

### Reads during synthesis

All archive access goes through phase 2 `TelegramArchiveQuery`. Proposal sampling and
brief drafting use search/window with the same deleted-default and caps. No second FTS
path.

## Failure handling

- Wiki path missing / unreadable index → proposal engine disabled with an actionable
  owner alert; archive retrieval still works.
- Approve when brief write fails → do not leave a half-applied mapping without recording
  the failure; prefer transaction-like ordering: persist mapping intent, write brief,
  write memory line, mark proposal approved; surface retry if a step fails.
- Reject is always safe (DB only).
- Sweep/import proposal DM failures retry without duplicating pending rows.

## Testing

### Unit

- At most one pending proposal per chat.
- Rejected proposals are not re-emitted by sweep without fingerprint change.
- Approve path writes mapping + brief + single memory line; reject writes none.
- Memory helper upserts one line per project and does not duplicate on re-approve/refresh.
- Brief writer never escapes `wiki/<project>/`.

### Integration

- Fake archive + temp wiki: import-complete trigger creates a pending proposal for a
  matching project name.
- Approve then read wiki page and `MEMORY.md`; reject then confirm both unchanged.
- Synthesis reads go through `TelegramArchiveQuery` mocks/spies only.

### Manual acceptance

1. Finish importing a chat clearly about an existing wiki project; receive one proposal.
2. Reject → confirm no wiki/memory change; chat still searchable in phase 2.
3. Rematch or use another chat; approve → mapping stored, brief present, one memory line.
4. Run sweep; confirm no duplicate nag for the rejected chat.
5. Confirm banter-only content did not become brief body by default.

## Acceptance criteria

Phase 3 is complete when:

- proposals fire after import (when confident) and on periodic sweep;
- approve/reject is required before any wiki or memory write;
- approved mappings persist and drive a locator-style wiki brief;
- `MEMORY.md` gains at most one line per confirmed project (title + path);
- rejected and unmapped chats never enter briefs;
- low-signal content stays out of briefs by default;
- all archive reads use the phase 2 query API;
- typecheck, selftest, automated tests, and the manual acceptance flow pass.

## Ordering

Implement and ship phase 2 before phase 3. Phase 3 assumes `TelegramArchiveQuery` and
citation behavior already exist.
