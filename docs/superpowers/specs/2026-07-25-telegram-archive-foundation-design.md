# Telegram archive foundation — design

Date: 2026-07-25
Status: approved for implementation planning

## Purpose

Wire Icarus to Jeon's personal Telegram account as a read-only, local-first archive.
Selected direct messages and groups are imported from their first available message,
including all Telegram-hosted media, and then kept synchronized with edits, deletions,
replies, reactions, and poll changes. The import is resumable, quiet, and visible through
the existing owner bot.

This is phase 1 of a three-phase program:

1. Build a complete and trustworthy local Telegram archive.
2. Add natural-language retrieval with message-level provenance.
3. Build confirmed cross-chat project mappings and project briefs.

The phases are separate because archive correctness should not depend on agent analysis,
and retrieval should have stable storage semantics before project synthesis is designed.

## Goals

- Replace the current manual session-copy flow with a guided, validated local setup.
- Let Jeon search and select any eligible direct message or group, not only the latest
  20 dialogs.
- Import the entire available history of each selected chat.
- Retain every Telegram-hosted media item. Preserve external-link context and a
  best-effort text snapshot of accessible pages.
- Resume imports after process restarts, network failures, and Telegram flood-waits
  without duplicates.
- Track new messages, edits, deletions, replies, reactions, and poll updates after import.
- Retain locally archived content after Telegram deletion, marked with the observed
  deletion time.
- Keep detailed progress under `/tg` while sending only start, completion, and actionable
  error DMs.
- Prepare an FTS5 index and a narrow archive API for later natural-language retrieval.
- Never send messages or perform other writes through Jeon's personal Telegram account.

## Non-goals

- Natural-language archive questions are phase 2.
- Chat profiles, project mapping, durable memory extraction, and wiki briefs are phase 3.
- Historical messages do not run through live triage and do not produce batch digests.
- Channels, Saved Messages, and bot conversations are not eligible in phase 1.
- The archive is not encrypted at the application layer. It relies on the local Windows
  account and remains outside git.
- No local browser UI is added. Management stays in the owner bot and setup stays local.
- No attempt is made to bypass Telegram access controls, recover unavailable content, or
  guarantee state that Telegram no longer exposes after a long outage.

## Current state

`src/connectors/telegramUser.ts` already starts a read-only gramJS client when
`TG_API_ID`, `TG_API_HASH`, and `TG_SESSION` are present. It listens for new messages in
whitelisted chats, buffers them for five minutes or 50 messages, appends Markdown logs,
downloads media up to 20 MB, and queues live triage.

The live deployment currently has all three personal-account settings unset. The setup
script prints a session string that must be copied into `.env` manually. `/tg` lists only
20 recent dialogs. Storage is append-only Markdown, so it cannot represent complete
history, durable cursors, edits, deletions, reactions, poll updates, or reliable search.

## Architecture

Phase 1 remains inside Icarus's single Node process. It adds a code-only synchronization
lane alongside, not inside, the single global agent-turn queue.

### Components

`tg-setup`
: An interactive local command that collects Telegram API credentials, performs
  phone/code/2FA login, verifies the resulting session, and atomically updates the three
  Telegram settings in `.env`.

`TelegramAdapter`
: A narrow interface over gramJS for dialog search, history pages, media downloads,
  global update differences, supergroup update differences, and live events. Production
  code uses gramJS; tests use a deterministic fake.

`TelegramSyncManager`
: Owns one synchronization lane. It starts/resumes import jobs, handles live events,
  persists update positions, performs reconnect reconciliation, applies rate limits, and
  exposes status. It does not submit historical work to the agent queue.

`TelegramArchiveStore`
: Owns Telegram-specific SQL operations and transactions. Other modules do not issue
  ad-hoc Telegram archive SQL.

`TelegramBlobStore`
: Writes content-addressed media and link snapshots below `archive/telegram/` using
  partial files and atomic renames.

`TelegramArchiveUI`
: Renders the `/tg` dialog picker, import confirmation, progress, pause/resume/cancel,
  retry, and connector-health views.

The existing live triage remains downstream of newly observed live-message bursts. It
receives text rendered from committed archive rows. Backfilled messages never enter its
buffers.

## Guided setup

Add `npm run tg-setup` and replace the copy/paste-oriented `tg-login` experience.

The command:

1. Loads an existing `.env` if present.
2. Prompts for missing `TG_API_ID` and `TG_API_HASH`.
3. Performs phone, code, and optional 2FA authentication locally.
4. Saves the gramJS string session in memory.
5. creates a second client from the saved session and verifies authorization.
6. Rewrites only `TG_API_ID`, `TG_API_HASH`, and `TG_SESSION` in `.env`.
7. Writes a temporary file beside `.env`, flushes it, and atomically renames it.
8. Prints a redacted success summary and tells Jeon to `/restart`.

The command never prints the API hash or session. It preserves comments, unrelated
settings, and the existing newline style. A failed login or verification leaves `.env`
unchanged. The existing `tg-login` script is removed or becomes a compatibility alias to
`tg-setup`; there must be one canonical setup path.

At boot, partial configuration is an explicit unhealthy state rather than silently
disabled. Completely absent configuration remains "not configured." Authorization
failure sends one deduplicated owner alert and leaves the archive readable.

README setup and day-to-day sections document the personal-account feature separately
from the BotFather owner bot: create Telegram API credentials, run `npm run tg-setup`,
restart, select chats with `/tg`, and verify status. Setup must not rely on `.env.example`
comments or an error message as its only documentation.

## Chat selection and management

`/tg` is available only when the personal client is authorized. It shows connector
health and selected/importing chats first, then paginated eligible dialogs.

- Eligible kinds: direct messages, basic groups, and supergroups.
- `/tg <query>` filters eligible dialogs by title or username.
- Pagination uses the existing short-lived callback reference registry rather than
  placing peer identifiers directly in callback data.
- Listing unselected dialogs fetches only dialog metadata. Message content is not fetched
  until import confirmation.
- Selecting a dialog creates a paused import job and fetches Telegram's available message
  count. Media byte size is shown as "calculated during scan" because Telegram does not
  expose a reliable aggregate before walking history.
- A separate confirmation starts full import. Toggling a chat off does not erase its
  archive.
- Per-chat controls are pause, resume, cancel, retry failed items, and remove archive.
  Remove archive is destructive, separate from selection, and requires typed
  confirmation. It is not an inline one-tap action.

Per-chat status includes import phase, available/imported message counts, discovered and
downloaded media bytes, failed media/link counts, oldest imported message time, last live
update, last verified update position, and the next retry time if paused by Telegram.

The `/status` summary distinguishes `not configured`, `partial config`, `connecting`,
`connected`, `temporarily offline`, and `authorization failed`. When configured, it also
shows selected-chat count, active import progress, last live event, and last successful
reconciliation. It does not treat session-string presence as connection health.

## Storage

All schema changes are appended as new migration strings in `src/db.ts`.

SQLite remains the source of truth. The design requires logical tables for:

- chats and selection/import state;
- participants observed in selected chats;
- current message state keyed by `(chat_id, message_id)`;
- immutable message versions, including original text/caption and later edits;
- deletion tombstones with observation time;
- replies and grouped-message relationships;
- current reactions and observation time;
- polls, poll options, votes/counts visible to the account, and snapshots;
- media descriptors and message-to-blob references;
- link occurrences, Telegram preview metadata, fetch state, and snapshot references;
- import jobs, page cursors, durable work queue items, retry state, and failures;
- global Telegram update state and per-supergroup update positions.

Messages store Telegram peer and sender identities, sent/edited/deleted timestamps,
entities, reply targets, grouping identifiers, text/caption, and enough source identity
to generate a Telegram deep link where Telegram supports one.

An FTS5 virtual table indexes current message text, captions, and successful linked-page
text snapshots. Deleted messages remain indexed but carry a deleted marker so phase 2 can
exclude them by default or include them explicitly. FTS maintenance is transactional with
the source rows.

Binary data lives under a new gitignored root:

```
archive/telegram/
  blobs/sha256/<prefix>/<hash>
  links/sha256/<prefix>/<hash>.json
  tmp/
```

Media blobs are content-addressed after download, deduplicating repeated files while the
database preserves every original filename, MIME type, Telegram media identity, sender,
chat, and message occurrence. Link snapshots store response metadata, fetch time, final
URL, content hash, and bounded extracted text. Partial downloads use `.part` files under
`tmp/` and become visible only after verification and atomic rename.

`archive/` is never committed. It is durable personal data, not disposable cache.

## Historical import flow

Only one historical chat imports at a time.

1. The manager claims the next runnable job.
2. It fetches a history page from the persisted oldest-message cursor.
3. One database transaction upserts participants and current message state, appends
   unseen versions, records polls/reactions/links/media descriptors, updates FTS, enqueues
   content acquisition, and advances the cursor.
4. It repeats newest-to-oldest until Telegram returns no older messages.
5. It drains the chat's Telegram media queue and link-snapshot queue.
6. It verifies stored counts against Telegram's available count, records any explainable
   discrepancy, and marks the import complete.

History and live events may overlap. Uniqueness constraints and version-content hashes
make replay idempotent. A restart resumes after the last committed page; no cursor is
advanced before its page transaction commits.

Telegram media has no application size cap. Before each download, the manager checks
free space on the archive volume. It pauses all new blob downloads when free space drops
below 10 GB, sends one owner alert for that pause, and resumes only after space recovers
or Jeon explicitly retries. Already committed message metadata continues to be safe.

Media download failures are classified:

- transient network errors retry with bounded exponential backoff;
- Telegram flood-waits resume at the server-provided time;
- unavailable or forbidden media becomes a permanent per-item failure;
- hash/write/rename failures pause the item and surface an actionable storage error.

## External links

Every URL occurrence retains the original URL, sender, chat/message identity, message
context, and Telegram preview fields even when the page cannot be fetched.

The snapshot worker performs a best-effort anonymous fetch with:

- redirects recorded;
- a 20-second request deadline;
- a 5 MB response-body limit;
- text extraction only for supported textual responses;
- at most 1 MB of normalized extracted text stored per snapshot;
- no login automation and no execution of page scripts;
- permanent states for unsupported content, login walls, robots/policy refusal, and
  repeated not-found responses.

The same normalized final URL may reuse a recent identical content snapshot, while each
message keeps its own occurrence and provenance. Casual reels and memes are retained
exactly like other links; relevance classification belongs to phase 3.

## Live synchronization

The adapter subscribes to new messages, edits, deletions, reaction changes, and poll
updates. Each event is committed immediately to the same normalized archive before it is
eligible for live triage.

For direct messages and basic groups, the manager persists Telegram global update
positions and reconciles with the MTProto difference API after reconnect. For
supergroups, it also persists per-peer update positions and uses the channel-difference
API. History reconciliation checks recent message state after an update gap.

Edits append an immutable message version and update current state. Deletions set
`deleted_at` but retain text and blob references. Reaction and poll updates replace their
current snapshot while keeping an observation timestamp. Unknown-message events enqueue
a targeted message fetch rather than being discarded.

Telegram does not promise infinite recovery of every ephemeral update. The UI therefore
reports a last verified update position and any unresolved gap. It must not claim exact
mirroring when Telegram can no longer supply missing state.

Connection-state changes update health immediately. Transient disconnects enter a
persisted reconnect loop and remain visible as temporarily offline; they do not wait for
an unrelated `/tg` call to be discovered. Authorization failure stops reconnect attempts
and alerts once. Successful reconnect always runs difference recovery before health
returns to connected.

## Live triage integration

The existing five-minute/50-message burst policy remains for newly observed live
messages. The buffer contains archive identities, not the only copy of message content.
At flush, triage input is rendered from committed rows plus a bounded recent conversation
window.

Backfill-originated rows never trigger triage. Replayed update-difference events trigger
triage only when they represent messages newer than the last committed live watermark
and have not previously been triaged. Edits, reactions, and poll changes may update an
open burst; they do not independently DM Jeon unless a future design explicitly adds
that behavior.

Every chat uses a distinct queue identity, `job:tg-triage:<stable-chat-key>`. This is
required because the global queue coalesces pending jobs with the same identity. Batches
from the same chat may coalesce in order; batches from different chats must never merge
into one agent turn. The human-readable turn kind remains `job:tg-triage`, with chat
identity stored separately for status and diagnostics.

Each triage attempt records per-chat success, failure, and last-triaged message watermark.
A failed triage remains visible under `/tg`; a terminal failure sends one deduplicated
owner alert containing the chat and archived batch range. The archive and watermark make
retry safe without replaying already successful batches.

## Progress and owner notifications

Detailed state lives under `/tg`. Automatic DMs are limited to:

- import started, including chat title and available message count;
- import completed, including messages, media bytes, link snapshots, and failures;
- authorization revoked or credentials invalid;
- import paused for low disk space;
- a permanent import or live-triage failure requiring action.

Transient errors, ordinary flood-waits, page progress, and individual unavailable links
do not generate DMs.

Cancel prevents future work and preserves imported rows/blobs. Resume continues from the
cursor. Retry resets only retryable failed work items. Removing a chat archive deletes
its relational rows and references, then garbage-collects unreferenced blobs; it never
deletes blobs still referenced by another message.

## Failure handling

- **Partial Telegram configuration:** boot as unhealthy with an actionable `/status`
  message; do not attempt connection.
- **Dead session:** stop network sync, keep archive reads available, alert once per
  session value.
- **Transient network error:** bounded exponential backoff with persisted next-attempt
  time.
- **Flood-wait:** honor Telegram's exact retry delay; do not busy-loop.
- **Database transaction failure:** roll back the page/event and leave its cursor
  unchanged.
- **Disk pressure:** pause blob downloads below 10 GB free; metadata work may continue.
- **Process shutdown:** stop claiming work, finish or roll back the active transaction,
  close partial file handles, and leave queue items resumable.
- **Corrupt or incomplete blob:** keep it outside the content-addressed store, record the
  failure, and retry according to classification.
- **Unavailable link:** retain occurrence and preview metadata with a permanent snapshot
  status.
- **Unrecoverable update gap:** record the gap, reconcile current history best-effort,
  and show degraded fidelity in `/tg`.

## Privacy and security

- The personal-account client is read-only. No send, edit, delete, join, vote, react, or
  mark-read operation is exposed through the adapter.
- Only groups and DMs explicitly selected by Jeon have message content fetched.
- Secrets remain in `.env`, are redacted from status and logs, and are never stored in
  SQLite.
- `archive/`, `state/`, `inbox/`, `outbox/`, `artifacts/`, and `.env` remain gitignored.
- The archive is plain local data by explicit choice; no application-level encryption is
  added.
- Historical import itself invokes no agent and no tools, limiting prompt-injection
  exposure. The existing accepted risk for new-message live triage remains unchanged.
- Conservative single-lane fetching, server flood-waits, and explicit selection reduce
  Telegram account-risk from aggressive automation.

## Testing

### Unit tests

- `.env` editing preserves unrelated lines/comments/newlines and never leaks secrets.
- Setup failure leaves `.env` byte-identical.
- Archive upserts are idempotent.
- Edits create immutable versions; deletions retain content and set tombstones.
- Reaction and poll snapshots replace current state correctly.
- FTS inserts, edits, and deleted markers remain transactionally consistent.
- Page cursors advance only with committed pages.
- Duplicate live/backfill events do not duplicate rows, versions, blobs, or triage.
- Simultaneous bursts from different chats receive different queue identities and never
  coalesce; multiple pending bursts from one chat preserve order when coalesced.
- Media hashing, content deduplication, partial-file cleanup, and low-disk pauses work.
- Link deadlines, size limits, redirects, deduplication, and permanent failures work.
- `/tg` search, pagination, status, confirmation, and destructive confirmation render
  within Telegram callback limits.
- `/status` distinguishes configuration, authorization, and live connection states
  without exposing credentials.

### Integration tests

A fake `TelegramAdapter` drives:

- interrupted import and process restart;
- a live event arriving during overlapping history backfill;
- global and supergroup difference recovery;
- flood-wait persistence and resume;
- targeted fetch for an unknown edited/deleted message;
- transient disconnect, reconnect, and authorization-revocation state transitions;
- simultaneous triage flushes from two chats without cross-chat prompt merging;
- media failure without poisoning the parent import;
- cancel, resume, retry, and blob garbage collection.

No test or CI run requires a real Telegram account.

### Manual acceptance

Use one test DM and one test group with known text, replies, edits, deleted content,
reactions, a poll, files, photos, and external links.

1. Run `npm run tg-setup`, verify redacted success, restart, and confirm connected status.
2. Find both chats using `/tg <query>`, select them, and confirm import.
3. Restart during backfill and verify import resumes without duplicates.
4. Verify available/imported message counts and every Telegram media item.
5. Verify accessible link snapshots and explicit statuses for inaccessible links.
6. Edit, delete, react, and vote; confirm current state and preserved history.
7. Disconnect long enough to miss updates, reconnect, and verify difference recovery or
   an explicit degraded-fidelity warning.
8. Confirm no message content from an unselected chat exists in the database or archive.
9. Confirm historical rows produced no triage DMs and live bursts still follow the
   existing quiet-window behavior.
10. Flush live bursts from the DM and group at the same time; confirm they produce
    separate triage turns and per-chat status.

## Acceptance criteria

Phase 1 is complete when:

- guided setup produces a validated live connection without manual secret copying;
- README documents setup, selection, status, and restart from a clean install;
- any eligible group or DM can be found, selected, and confirmed through `/tg`;
- a medium-scale full-history import survives restarts and rate limits;
- all available Telegram-hosted media is retained subject only to disk availability and
  explicit permanent Telegram failures;
- messages, versions, tombstones, replies, reactions, polls, links, blobs, and cursors
  are idempotent and queryable;
- ongoing live state is reconciled after ordinary downtime, with unresolved gaps shown
  honestly;
- unselected chat content is never persisted;
- live triage batches from different chats never share an agent turn;
- progress and actionable failures are visible without noisy DMs;
- typecheck, selftest, automated tests, and the manual acceptance flow pass.

## Follow-on phases

Phase 2 will design narrow read-only archive tools for FTS search and conversation-window
loading. Natural-language answers will cite chat, sender, timestamp, and a Telegram deep
link where available, without injecting the entire archive into prompts.

Phase 3 will design chat profiles and project synthesis. Icarus will propose mappings
against existing wiki projects, Jeon will confirm them, and only then will project briefs
and durable memory be written. Low-signal social content remains searchable but does not
enter briefs by default.
