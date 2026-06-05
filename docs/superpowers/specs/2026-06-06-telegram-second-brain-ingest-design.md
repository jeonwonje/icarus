# Telegram second-brain ingest — design

**Date:** 2026-06-06
**Status:** Approved design, pre-implementation
**Skill:** `skills/telegram/`

## Purpose

Give the icarus hub a "second brain" view of the operator's Telegram: a full,
ongoing archive of **all** DMs, groups, and channels, distilled into per-chat
digests that let Claude know what's going on across fragmented, sloppily-typed
conversations — open threads, who's waiting on a reply, commitments, key facts.

This is the third icarus ingest source after `canvas` (live API) and `outlook`
(file export). It follows the same shape: a dumb mechanical ETL script plus
Claude as the intelligence layer at curation time.

## Scope

- **In:** full history of every dialog (user DMs, small groups, megagroups,
  broadcast channels), media downloads under a size cap, incremental catch-up on
  every run, Claude-authored rolling digests, surfacing actionable items into the
  hub index.
- **Out (YAGNI for v1):** full-text/embedding search index (possible future
  add-on once the archive exists), unattended/cron digesting via an LLM API,
  sending messages, any write back to Telegram, encryption-at-rest.

## Key decisions

| Decision | Choice | Why |
|---|---|---|
| Architecture | ETL script + Claude-as-digester | Matches canvas/outlook; fewest deps; understanding belongs in Claude, not a rigid script |
| Where understanding lives | Ingest-time rolling digests (not query-time raw reads, not a search index) | Scales to huge history; Claude reads small digests first, drills into raw only when needed |
| Raw archive location | Local-only, **outside** the OneDrive hub | Other people's private DMs must not sync to Microsoft's cloud |
| Engine | GramJS (`telegram` on npm) | MTProto user-account access (takeout + full history); the Bot API cannot do this |

## Dependency departure (important)

icarus's convention is "skills are dependency-free `.mjs`, Node built-ins +
`fetch` only." **The telegram skill is the one documented exception:** MTProto
cannot be hand-rolled from built-ins, so it depends on GramJS.

- Add `telegram` to root `package.json` `dependencies`.
- `canvas` and `outlook` remain dependency-free and run anywhere; only the
  telegram skill requires `npm install`.
- Document the exception in `CLAUDE.md` (Conventions section) and call it out at
  the top of `skills/telegram/SKILL.md`.

## Components

```
skills/telegram/
  SKILL.md                 # frontmatter description + two-step workflow (run ingester → curate digests)
  scripts/login.mjs        # one-time interactive login → prints a StringSession
  scripts/sync.mjs         # GramJS ETL: pull → normalize → archive → emit delta
  scripts/sync.test.mjs    # vitest over pure helpers (GramJS client injected)
```

`sync.mjs` exports its pure helpers + `syncTelegram({client, paths, opts})` for
tests and guards `main()` so importing it does not run it (icarus convention).
The GramJS client is **injected** into `syncTelegram`, so tests never touch the
network.

## Auth & secrets

All secrets live in `~/.bashrc` (the environment), never in the hub or the
archive — same rule as `canvas`. A GramJS `StringSession` is a full account
credential, so it is env-only.

- `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` — from my.telegram.org (one-time).
- `TELEGRAM_SESSION` — a GramJS `StringSession` string.
- Created by `node skills/telegram/scripts/login.mjs`: prompts for phone number →
  login code → 2FA password (if set), then prints the session string for the
  operator to paste into `~/.bashrc`. The login script writes the session to
  **stdout only** — never to disk.

Missing/invalid env → `sync.mjs` exits with a clear message pointing at
`login.mjs`.

## Storage layout

### Raw archive — local, outside the hub

Base dir: `${TELEGRAM_ARCHIVE_DIR:-/mnt/c/Users/jeonw/Desktop/telegram-chats}`.

```
$ARCHIVE/
  archive/
    <chat-slug>/                 # slug = sanitized-title + "-" + numeric dialog id
      messages.jsonl             # append-only; one normalized message per line
      media/<msgid>-<name>       # downloaded media
  .telegram-manifest.json        # per-dialog ledger (cursor + dedup + digest cursor)
  delta/latest.json              # new messages since last digest — Claude consumes this
```

- `messages.jsonl` is the faithful source of truth. Each line is a normalized
  record: `{ id, date, from, text, reply_to, media }` (media = `{type, path,
  size}` or `{type, skipped:"oversize", size}`).
- Synced files are `chmod 0o444` after write, matching icarus.
- **Caveat to record:** `~/Desktop` is currently *not* OneDrive-redirected, so
  the archive is local. If the operator ever enables Windows OneDrive "Back up
  Desktop," the raw archive would begin syncing to the cloud — re-point
  `TELEGRAM_ARCHIVE_DIR` if that happens.

### Manifest entry (per dialog)

```json
{
  "<dialog-id>": {
    "title": "Mom",
    "type": "user",            // user | group | channel
    "slug": "mom-1404758730",
    "lastId": 48213,           // highest message id archived (incremental cursor)
    "lastDigestedId": 48190,   // highest id Claude has folded into the digest
    "mediaIds": [48201, 48207] // downloaded media ids (dedup)
  }
}
```

### Hub output — digests only, written by Claude

```
<hub>/telegram/
  dms/<chat-slug>.md             # one rolling digest per DM
  groups/<chat-slug>.md          # one per group / megagroup / broadcast channel
<hub>/index.md                   # ## Telegram section — only genuinely actionable items
```

DMs (`type: user`) → `dms/`; everything else (group / megagroup / channel) →
`groups/`. Mirrors outlook's `email/` + `## Inbox`.

## Data flow

### Bootstrap (first run — manifest absent)

1. Open a **takeout session** (`account.initTakeoutSession` via `client.invoke`)
   for relaxed flood limits on the bulk pull.
2. Enumerate all dialogs (`client.getDialogs`).
3. For each dialog, page **backward** through full history: append normalized
   records to `messages.jsonl`, download media under the size cap, record
   `lastId` + `mediaIds`. The cursor is advanced **per dialog, only after its
   batch is durably written**, so an interrupted run resumes cleanly.
4. **Backlog is bounded for digesting:** all history is archived silently, but
   `delta/latest.json` is seeded with only the last
   `${TELEGRAM_DIGEST_DAYS:-30}` days. Claude never bulk-summarizes years of
   history; older messages stay archived and available on demand.

### Incremental (every later run)

1. For each dialog, fetch only messages newer than the stored `lastId`
   (`min_id` cursor).
2. Append new records, download new media, advance `lastId` + `mediaIds`.
3. Write `delta/latest.json` = everything new this run, grouped by chat.
4. Print a summary line: `N chats, M new messages, K media, P skipped-oversize`.

### Idempotency

- Re-running with no new messages is a no-op.
- Message-id dedup via the manifest means a crash mid-run never double-writes.
- Media already in `mediaIds` is skipped.

## Media handling

- Cap: `${TELEGRAM_FILE_MAX_MB:-100}` MB. (Telegram Premium allows downloads up
  to ~4 GB; the operator can raise the cap.)
- Oversized files are **not** downloaded; a `{type, skipped:"oversize", size}`
  stub is recorded in the message so the digest can still note "sent a 580 MB
  video."

## Digest curation (Claude's job, driven by SKILL.md)

The script never summarizes. After `sync.mjs` runs, `SKILL.md` instructs Claude:

1. **Read `delta/latest.json`**, grouped by chat.
2. **For each chat with new activity**, open the existing digest
   (`telegram/dms/<slug>.md` or `groups/<slug>.md`) or create it, and update:
   - **Summary** — rolling narrative of the relationship / thread.
   - **Open threads** — unanswered questions, undecided things.
   - **Action items** — what the operator owes, what they're waiting on, deadlines.
   - **Key facts** — durable details (addresses, decisions, plans, preferences).

   This is where understanding of fragmented, poorly-punctuated texting lives —
   Claude infers meaning a rigid script cannot.
3. **Surface only genuinely actionable items** (someone waiting on a reply, a
   dated commitment) into `<hub>/index.md` under `## Telegram`. Routine chatter
   stays in the per-chat digest, out of the index. Collapse threads to a single
   line; dedup against existing index entries.
4. **Mark the delta consumed:** advance `lastDigestedId` per chat in the manifest
   so the next run's delta picks up cleanly.

**Bootstrap digest:** on first run Claude digests only the seeded 30-day delta
and writes an initial digest per active chat.

## Error handling

| Condition | Behavior |
|---|---|
| Missing/invalid env | Exit with a message pointing at `login.mjs` |
| `FLOOD_WAIT_X` | Honor GramJS's auto-sleep; takeout session minimizes these |
| Media download failure | Log, skip, retry next run (do not mark as downloaded) |
| Interrupted run | Per-dialog cursor resumes; JSONL append + manifest dedup prevent double-writes |
| Oversize media | Skip download, record stub (see Media handling) |

## Testing

`scripts/sync.test.mjs` (vitest, `skills/**/*.test.mjs`), GramJS client injected —
no network. Pure helpers under test:

- `slugify` (title + id → stable slug)
- message normalization (TL message → record), including reply + media shapes
- JSONL append/parse round-trip
- manifest cursor logic (`lastId` advance, `mediaIds` dedup, `lastDigestedId`)
- delta builder (30-day windowing on bootstrap; `min_id` filter incrementally;
  grouping by chat)
- env validation
- oversize-skip stub

## Open items / future work

- Full-text or embedding **search index** over `messages.jsonl` (Approach C) —
  deliberately deferred; revisit once the archive exists.
- Optional unattended digesting — out of scope; digests are Claude-driven by
  design.
