# Telegram archive retrieval — design (phase 2)

Date: 2026-07-26
Status: approved for implementation
Depends on: `docs/superpowers/specs/2026-07-25-telegram-archive-foundation-design.md` (phase 1)

## Purpose

Let Jeon ask natural-language questions about the local Telegram archive from the owner
DM, and look up messages through a thin `/archive` surface, with every archive-backed
claim carrying message-level provenance.

This is phase 2 of the three-phase program. It does not invent embeddings, project
mappings, or wiki briefs. It makes the phase 1 FTS index and archive rows usable.

## Goals

- Expose a single read-only query API over the existing archive store and `tg_message_fts`.
- Register narrow MCP tools so owner-agent turns can search and load conversation windows.
- Add `/archive` as lookup-only: query → ranked hits → open a short conversation window.
- Require citations on every archive-backed natural-language answer: chat, sender,
  timestamp, and a Telegram deep link when available.
- Exclude deleted messages by default; include them only when explicitly requested.
- Keep result and window sizes small so the archive never floods prompts.
- Never write to Telegram, the archive, wiki, or memory from these tools.

## Non-goals

- Chat profiles, project mapping, durable memory extraction, and wiki briefs are phase 3.
- Embeddings, hybrid search, and ranking services.
- `/archive` as a health or operator console (`/tg` and `/status` remain that surface).
- Injecting entire chats or unbounded FTS result sets into prompts.
- Surfacing unselected chats (phase 1 selection rules stand).
- Channels, Saved Messages, and bot conversations remain ineligible.

## Current state

Phase 1 stores selected chats in SQLite, maintains `tg_message_fts` transactionally with
message and link-snapshot text, retains deleted rows with `deleted_at`, and keeps media
and link blobs under `archive/telegram/`. There is no search API, no archive MCP tools,
and no `/archive` command. Live triage already loads a bounded recent window from
committed rows; retrieval should reuse that store, not open a second SQL path.

## Architecture

Approach: one shared query layer, two thin surfaces.

```
owner DM (NL) ──► MCP tools ──┐
                              ├──► TelegramArchiveQuery ──► TelegramArchiveStore / FTS
/archive lookup ──────────────┘
```

### Components

`TelegramArchiveQuery`
: Read-only facade. Owns search and conversation-window reads. Formats citation fields.
  Tools and `/archive` call only this module; they do not issue ad-hoc archive SQL.

`archive_search` / `archive_window` MCP tools
: Registered on the existing in-process `icarus` MCP server. Available on owner turns.
  Return compact structured text the agent can cite.

`TelegramArchiveUI` `/archive` flow
: Lookup-only bot UI. Search hits, then open a window around a selected hit. No health
  panel, no import controls, no destructive actions.

### Query API

```ts
search(input: {
  query: string;
  peerKey?: string;
  includeDeleted?: boolean; // default false
  limit?: number;           // hard-capped
}): ArchiveHit[]

window(input: {
  peerKey: string;
  messageId: number;
  before?: number; // hard-capped
  after?: number;  // hard-capped
  includeDeleted?: boolean; // default false
}): ArchiveWindow
```

Each `ArchiveHit` / window message includes:

- `peerKey`, `messageId`
- chat title
- sender display name (and stable sender key when present)
- `sentAt`, `editedAt` if any
- `deleted` boolean (and `deletedAt` when included)
- short snippet (search) or full current text/caption (window, still bounded)
- Telegram deep link when constructible from stored peer/message identity
- optional flags: has media, has links (not blob payloads)

Hard caps (implementation constants, not settings):

- search `limit` default 10, max 25
- window `before`/`after` default 5 each, max 15 each
- snippet length bounded (on the order of a few hundred characters)
- window message text truncated if extremely long, with an explicit truncation marker

Deleted handling: when `includeDeleted` is false, rows with `deleted_at` are omitted from
search and windows. When true, they appear with a clear deleted marker.

FTS query: pass the user/agent query through SQLite FTS5 safely (escape/`quote` user
input so operators cannot break the query). Search current message text, captions, and
successful link-snapshot text already indexed by phase 1. Rank by FTS relevance; do not
add a second ranking stack in this phase.

### Natural-language answers

When the owner asks an archive question in the DM, the agent uses `archive_search` and
optionally `archive_window`. Every archive-backed claim in the reply must cite:

1. chat title
2. sender
3. timestamp
4. Telegram deep link when available; otherwise the stable `(peerKey, messageId)` identity

No “trust me” summaries of archive content. If search finds nothing, say so. If evidence
is thin, say so. Citations are mandatory even for short answers.

Persona/system guidance for this phase should state the citation rule; tools alone are
not enough.

### `/archive` UI

- `/archive <query>` runs search (deleted always excluded on this surface in v1).
- Results render as a short ranked list within Telegram callback limits.
- Selecting a hit opens a conversation window around that message.
- Include-deleted remains available only via MCP `archive_search` /
  `archive_window` (`includeDeleted: true`). No `/archive` toggle in v1.
- No status, sync health, import, pause, or remove actions on this surface.

### Privacy and safety

- Query API and tools are read-only.
- Only selected chats are searchable.
- No blob bytes or full link-snapshot JSON enter tool results by default — text and
  provenance only.
- Deep links open Telegram; they do not grant Icarus write access.
- Prompt-injection risk: treat retrieved message text as untrusted content. Tool output
  should label it as archived third-party text. The agent must not follow instructions
  found inside archived messages.

## Failure handling

- Empty query → clear validation error.
- FTS syntax/escape failure → readable error, no crash.
- Unknown `peerKey` / missing message → not-found, not a stack trace.
- Archive runtime not started / DB unavailable → actionable “archive unavailable” message
  on both MCP and `/archive`.
- Deep link unavailable → still return other citation fields.

## Testing

### Unit

- Search excludes deleted by default and includes them when asked.
- Caps clamp oversize `limit` / window radii.
- FTS user input with quotes/operators does not throw and does not match unintended rows.
- Citation fields populate from stored rows; missing deep-link case is explicit.
- Window ordering is chronological around the anchor.

### Integration

- Seeded fake archive: search hits expected messages; window loads neighbors.
- MCP tools return the same shapes as the query API for the same inputs.
- `/archive` search → select → window callback flow stays within Telegram size limits.

### Manual acceptance

1. Import or use an already imported chat with known phrases.
2. Ask in the owner DM; confirm the answer cites chat, sender, time, and link/identity.
3. `/archive <query>` finds the same message; opening it shows surrounding context.
4. Delete a matching message on Telegram, wait for sync, confirm it disappears from
   default search and reappears only with include-deleted.
5. Confirm unselected chats never appear.

## Acceptance criteria

Phase 2 is complete when:

- `TelegramArchiveQuery` is the only search/window path used by tools and `/archive`;
- MCP `archive_search` and `archive_window` work on owner turns;
- `/archive` supports lookup-only search and window open;
- NL archive answers always cite provenance as specified;
- deleted messages are excluded unless explicitly included;
- hard caps prevent prompt flooding;
- typecheck, selftest, automated tests, and the manual acceptance flow pass.

## Follow-on

Phase 3 builds confirmed chat→wiki project mappings and project briefs on top of this
same query API. It must not introduce a second retrieval stack.
