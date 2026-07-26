# Project raw shelf — design

Date: 2026-07-26
Status: approved for implementation planning
Amends:
- `docs/superpowers/specs/2026-07-26-telegram-content-triage-wiki-design.md`
  (runtime may write `Desktop/<project>/raw/` on intentional ingest; triage LLM still
  does not write Desktop project trees)
Depends on:
- `docs/superpowers/specs/2026-07-25-telegram-archive-foundation-design.md` (blobs)
- `docs/superpowers/specs/2026-07-26-telegram-content-triage-wiki-design.md` (sticky
  mapping, triage, ingest entry points)
- Desktop wiki schema (`wiki/CLAUDE.md`): sources are locators, not copies

## Purpose

Give intentional Telegram ingest a **human-readable home** under each Desktop project
(`<project>/raw/`), while keeping content-addressed archive blobs and the bot inbox as
bulk stores. The wiki continues to hold locators only.

Today, bot DMs land in dated `inbox/` folders and synced-chat media lives under
`archive/telegram/blobs/sha256/…`. Both are durable but hard to reopen by topic. Filing
must be selective (ingest / “file this”), topic-mapped to an existing wiki project, and
deduplicated by content hash so re-ingest does not stink up the shelf.

## Problem

- `inbox/<date>/` and `blobs/sha256/…` are machine-oriented; Jeon cannot browse “morianlabs
  vendor PDFs” without remembering dates or hashes.
- Dumping attachments into project working trees (CAD, docs, git) pollutes user files.
- A top-level `Desktop/raw/` would invent a second taxonomy beside the existing 1:1
  Desktop project ↔ wiki project layout.
- Auto-mirroring every archive attachment would bury the shelf; sync must stay complete
  in the blob store without curating `raw/`.
- Naive name-only collision handling can duplicate identical bytes under `-2` names.

## Goals

- On intentional **ingest** (DM and archive), runtime shelves bytes into
  `Desktop/<project>/raw/<readable-name>` before deep-ingest.
- Project choice: **sticky chat→project mapping if present; otherwise project picker**.
- Ingest **always** files first; wiki `src-` pages point at the **raw** path.
- Keep `archive/telegram/blobs` and `inbox/` as bulk stores; never delete blobs on file.
- **Content-hash dedup** per project `raw/`: same sha256 → reuse path; deep-ingest no-op.
- Hardlink when same volume; copy when not.
- Runtime is the only writer into `<project>/raw/`; agents do not invent project trees.
- Preserve locator-style wiki: no copies inside `wiki/`.

## Non-goals

- Auto-filing every Telegram attachment or the full archive into `raw/`.
- A top-level `Desktop/raw/` or any `wiki/.../raw/` / `wiki/sources/` tree.
- A separate v1 “file only” (shelf without ingest) button.
- Browsing `raw/` inside the `/wiki` Telegram browser.
- Encrypting `raw/` beyond the local Windows account.
- Changing phase-1 sync semantics (archive remains read-only on the personal account).

## Decisions (locked in brainstorming)

| Topic | Choice |
|---|---|
| Entry points | DM bot + archive (synced chats) |
| Project pick | Sticky mapping first; else wiki-project picker |
| Ingest vs file | Ingest always files (`fileToRaw` then deep-ingest) |
| Implementation | Runtime files first; agent ingests returned path |
| Shelf location | `Desktop/<project>/raw/` (per project) |
| Bulk stores | Blobs + inbox unchanged |
| Dedup | sha256 per project; reuse path if present |
| Dedup index | Icarus SQLite table (disk files remain human SoT) |
| Link strategy | Hardlink same volume; else copy |
| Naming | `YYYY-MM-DD_<sanitized-original>`; `-N` only for different bytes |
| Auto-file all media | No |

## Architecture

```
DM file / archive media (intentional ingest)
        │
        ▼
  Resolve project (sticky mapping | picker)
        │
        ▼
  fileToRaw(project, sourcePath | blobHash, displayName)
        │  sha256 → SQLite lookup → reuse | hardlink/copy
        ▼
  Desktop/<project>/raw/<readable-name>
        │
        ▼
  Agent deep-ingest on raw path
        │
        ▼
  wiki/<project>/src-…  (locator → raw path; + peer#msg / blob when archive)
```

Archive sync continues to write blobs only. Triage may surface an ingest action; it never
auto-shelves.

### Components

`fileToRaw` (`src/rawShelf.ts` or equivalent)
: Shared runtime helper. Inputs: wiki/Desktop project slug, source path and/or blob hash,
  display name. Outputs: `{ path, reused, hash }`. Creates `raw/` on first use. Refuses
  unknown slugs, missing Desktop project folders, and missing blobs. Never deletes inbox
  or blob bytes.

`raw_shelf` (Icarus SQLite)
: Index of shelved files for fast dedup: `(project, sha256) → relative path` (plus bytes,
  created_at). Disk under `Desktop/<project>/raw/` is what humans browse; the table is an
  accelerator. **Design invariant:** a full resync could be done by hashing each project's
  `raw/` and rewriting rows. **v1** only repairs on the miss path (index row points at a
  missing file → re-shelf that one object). A bulk rebuild command is a follow-on.

DM ingest path (`src/telegram/bot.ts` + UI)
: Owner-bot DM has **no** `tg_project_mappings` peer — always show the project picker.
  Then `fileToRaw` on the inbox path and deep-ingest on the **returned raw path** (not
  inbox).

Archive ingest path (triage / owner action)
: Intentional action carries peer, message id, media key / blob hash and filename.
  Sticky mapping for that `peerKey` if present, else picker → `fileToRaw` from blob →
  deep-ingest on raw path. Sync manager does not call `fileToRaw`.

Wiki / deep-ingest
: Unchanged skill semantics: locators + content hash idempotency. Prompt and persona
  guidance: after runtime shelving, ingest the raw path; cite Telegram provenance when
  known.

### Data layout

| Layer | Path | Role |
|---|---|---|
| Archive blobs | `icarus/archive/telegram/blobs/sha256/…` | Canonical synced media |
| Bot inbox | `icarus/inbox/<YYYY-MM-DD>/…` | DM landing zone |
| Human shelf | `Desktop/<project>/raw/<YYYY-MM-DD>_<name>` | Curated, browsable |
| Dedup index | Icarus DB table `raw_shelf` | sha256 → path per project |
| Wiki | `wiki/<project>/src-…` | Locator only |

`raw/` is gitignored in Desktop projects that have remotes. No top-level Desktop `raw/`.

### Naming and bytes

1. Sanitize the original filename (Windows-safe, length-capped), preserve extension.
2. Prefix with calendar date in `cfg.tz` (`ICARUS_TZ` / host default): `YYYY-MM-DD_`.
3. Compute sha256 of source bytes.
4. If `(project, sha256)` exists in index and the file is still on disk → return that path
   (`reused: true`).
5. Else choose destination name; if that basename exists with **different** hash, append
   `-2`, `-3`, … until free.
6. Hardlink from source into destination when both paths share a volume; otherwise copy.
7. Insert/update SQLite row. Return absolute path.

### Project resolution

1. **Archive ingest:** if `tg_project_mappings` has a sticky row for that chat's
   `peerKey` → use its wiki project slug.
2. **Owner-bot DM ingest:** no archive peer → **always** show the project picker (sticky
   does not apply). Captions/threads do not invent a sticky project in v1.
3. Picker lists wiki project slugs that also exist as `Desktop/<project>/` folders.
4. Refuse if the chosen slug has no matching Desktop directory.

### Flows

**DM**

1. Media still downloads to `inbox/<date>/` via `saveIncomingFile`.
2. Ingest action (button or caption intent) → **project picker** (no sticky) → `fileToRaw`
   → `submitOwnerText` deep-ingest on raw path.
3. Summarize / keep unchanged. Photos continue to the agent unless ingest is requested.

**Archive**

1. Sync stores media in blobs; no `raw/` writes.
2. Owner ingest action (from triage affordance or explicit control) supplies blob identity.
3. Same resolve → `fileToRaw` → deep-ingest; `src-` cites raw path and `peer#msg` /
   `blob:sha256:…`.

### Edge cases

| Case | Behavior |
|---|---|
| Unknown wiki slug / no Desktop folder | Refuse; DM error; no partial `raw/` write |
| Missing blob / unread inbox path | Refuse |
| Same bytes re-ingested | Reuse path; deep-ingest hash skip |
| Same display name, different bytes | `-N` suffix |
| Cross-volume source | Copy |
| Index row missing file on disk | Treat as miss; re-shelf; repair index |
| Triage LLM | Does not write `raw/`; may only propose ingest |
| Prior “never write Desktop projects” | Amended: runtime may write **only** `<project>/raw/` |

### Testing notes

- Unit: `fileToRaw` hardlink vs copy, sha256 reuse, `-N` collision, refuse missing project/blob.
- Integration: DM ingest callback ends with deep-ingest prompt pointing at `raw/`, not
  `inbox/`.
- Archive: ingest action from blob hash produces shelf file + index row without sync
  calling `fileToRaw`.
- Dedup: second ingest of identical bytes does not create a second file.

### Open follow-ons (out of v1)

- Separate “file only” button (shelf without wiki ingest).
- `/wiki` or bot UI to browse `raw/`.
- Rebuild-index maintenance command if SQLite drifts from disk.
