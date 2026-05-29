# Wiki ingest — source-grounded notes for icarus

**Date:** 2026-05-29
**Status:** Approved, ready for implementation plan
**Scope:** Spec 1 of 2. This spec covers the file/URL ingest loop. Spec 2 (a
separate document) covers the WSLg headed browser with persistent login and
human-in-the-loop handoff, and is explicitly out of scope here.

## Background

icarus is a single-operator Telegram life agent that spawns the `claude` CLI
per turn with `cwd = data/`. It maintains a shared wiki (`wiki/`, `index.md`,
`log.md`) but today it can only take notes from chat *text* — it silently
ignores any file attachment, and has no notion of source material.

Its sibling repo `product-manager` (PM) has a richer, source-grounded wiki
behaviour the operator wants: drop a file, the bot reads it and distills a
wiki page **grounded in an immutable source it cites**. This spec ports that
behaviour into icarus, keeping icarus's shape (single-operator DM, the
`claude` CLI — *not* PM's opencode/deepseek model layer).

## Goals

- Telegram attachments are saved as immutable sources under a `raw/` tree.
- `raw/` lives on the Windows Desktop so the operator can browse the files
  from Windows; the agent still references them as `raw/<file>`.
- When a file (or URL) arrives, the agent **auto-distills** it the same turn
  into a wiki page that **cites its source**, files the source under a
  self-chosen topic folder, updates `index.md`, and logs `[ingest]`.
- URLs pasted in chat are fetched via the agent's built-in `WebFetch` and
  distilled the same way (citation = the URL).

## Non-goals (deferred or dropped)

- **WSLg headed browser, persistent login, human handoff** → Spec 2.
- PM's opencode/deepseek model-agnostic layer — icarus stays on the `claude`
  CLI.
- PM's forum/multi-thread topology and per-thread memory — icarus stays
  single-operator DM, one `'life'` session.
- PM's Sodion-specific content: `raw/TOPIC_GUIDE.md` battery taxonomy,
  `create-fat` skill, company profile.
- PM's bulk-ingest CLI (`scripts/ingest.ts`, `initial-ingest.ts`),
  `/ingest` & `/pull` commands, and the git-backup timer. Not needed for a
  personal life agent; revisit only if a bulk archive ever appears.
- `pdftotext` / `tesseract` extraction recipes. Claude's `Read` tool reads
  PDFs and images natively, so these are unnecessary. Only opaque binaries
  (CAD/STEP/STL) need a metadata fallback (see Ingest behaviour).

## Architecture

### Storage layout

```
data/
  CLAUDE.md            ← persona (tracked) — gains an Ingest operation
  index.md             ← wiki catalog (gitignored)
  log.md               ← activity log (gitignored)
  wiki/                ← markdown notes (gitignored)
    _meta/<file>.meta.md   ← sidecars for opaque binaries
  outbox/              ← file delivery (gitignored)
  skills/<name>.md     ← skill recipes (tracked)
  raw/  ──symlink──▶  /mnt/c/Users/jeonw/Desktop/icarus-raw/
```

`data/raw` is a **symlink** to a folder on the Windows Desktop. Rationale: the
agent keeps citing sources as `raw/<file>` exactly like PM, nothing downstream
has to special-case an absolute `/mnt/c/...` path, and the bytes physically
live where Windows can browse them. DrvFs is slower than the WSL filesystem;
that is an accepted tradeoff (the operator chose it for Windows access).

The symlink target is configurable. Default:
`/mnt/c/Users/jeonw/Desktop/icarus-raw`. `wiki/`, `index.md`, and `log.md`
stay inside the repo's `data/` (fast, already gitignored).

### Data flow — file arrives

1. **Download.** `telegram.ts` detects an attachment
   (`document` / `photo` / `audio` / `voice` / `video`), downloads it via the
   Bot API `getFile` + HTTPS fetch, and writes it to `raw/<name>` at the top
   level of the `raw/` tree.
   - **Oversized guard.** Telegram's Bot API caps downloads at 20 MB. If an
     attachment's advertised `file_size` exceeds that, skip the download and
     warn the operator in the reply (do not fail silently). Photos are exempt
     (Telegram rescales them under the cap).
   - The bot appends a note to the turn's text, e.g.
     `[document: invoice.pdf] saved to raw/invoice.pdf`, so the agent knows
     what arrived even before reading `<new_sources>`.
2. **Surface.** `bootstrap.ts` injects two new blocks into the prompt prefix:
   - `<new_sources>` — top-level files under `raw/` with mtime newer than
     `log.md` (minus a 60s skew margin), i.e. files dropped since the last
     logged turn.
   - `<raw_folders>` — a 2-level directory listing of `raw/` (top-level
     folders always; second level capped per folder), so the agent can file
     new sources into an *existing* topic folder rather than inventing
     duplicates.
3. **Distill (same turn).** The agent:
   - Reads the source (`Read` for PDFs/images/text; binary fallback below).
   - Chooses an existing topic folder from `<raw_folders>` or creates a new
     one, and **moves** the file there: `raw/<topic>/<file>`.
   - Writes/updates a wiki page (one entity/concept per page) that **cites**
     `raw/<topic>/<file>`.
   - Updates `index.md`.
   - Appends a terse `[ingest]`-tagged line to `log.md`.

Because new arrivals land at the `raw/` top level and the agent moves them
into nested topic folders during ingest, an ingested file is no longer
top-level and will not re-surface in `<new_sources>` on later turns.

### Data flow — URL arrives

When the operator pastes a URL, the agent fetches it with its built-in
`WebFetch` tool and distills a wiki page the same way, except the citation is
the URL (no `raw/` file is created). No browser is involved in this spec;
login-walled / heavy-JS pages are a Spec 2 concern.

## Ingest behaviour (persona, `data/CLAUDE.md`)

Add an **Ingest** operation alongside the existing Query / Note-taking / Lint /
Skill operations:

- **Trigger.** Files in `<new_sources>` (or named in the turn text), and URLs
  pasted in chat. Ingest proactively, the same turn.
- **Files.** Claude's `Read` reads PDFs and images natively — use it directly.
  Only opaque binaries (CAD/STEP/IGES/STL/DWG, proprietary formats) need a
  fallback: gather what `file`/`stat`/`ls -la` reveal, write a
  `wiki/_meta/<file>.meta.md` sidecar noting what is inferred vs. known, and
  have the wiki page cite both the binary and its sidecar.
- **Filing.** Pick an existing topic folder from `<raw_folders>` when one fits;
  otherwise create a sensibly named new one (e.g. `raw/receipts/`,
  `raw/medical/`, `raw/travel/`). Move the source into it; cite the final
  path.
- **Source immutability.** Never edit files under `raw/`; never `rm -rf` in
  `raw/`. Sources are read-and-cite, not mutated. A destructive change
  (delete, large rename) is described and confirmed first, per existing rules.
- **Citations.** Every page distilled from a source cites it: `raw/<topic>/<file>`
  for files, the URL for links. Keep the existing "small pages compound"
  guidance.
- **Logging.** Append a `[ingest]` line per ingested item.

## Components changed

| File | Change |
|------|--------|
| `src/config.ts` | Add `RAW_DIR` env var; default `/mnt/c/Users/jeonw/Desktop/icarus-raw`. Export the resolved path. |
| `src/memory/scaffold.ts` | Add `rawDir()` (returns `data/raw`). In `ensureDataLayout()`: idempotently create the Desktop target folder and the `data/raw` symlink pointing at it. |
| `src/memory/bootstrap.ts` | Port `listNewSources()` and `listRawTree()` from PM; add `<new_sources>` and `<raw_folders>` to `buildBootstrapPrefix()`. |
| `src/telegram.ts` | Add `downloadTelegramFile()`; extract attachments (document/photo/audio/voice/video) → `raw/`; oversized (>20 MB) guard with operator warning; append `[<kind>: <name>] saved to raw/<name>` notes to the turn text. |
| `src/index.ts` | Thread the saved-file notes into the agent input alongside the message text. |
| `data/CLAUDE.md` | Add the Ingest operation, citation rules, topic-folder filing, binary `_meta` fallback. |

## Error handling

- **Oversized attachment:** skip download, warn in reply, do not crash the
  turn.
- **Download failure** (network, dangling `file_path`): log the error, tell
  the operator the file could not be fetched, continue the turn with text.
- **Symlink/scaffold:** if the Desktop mount is unavailable (`/mnt/c` missing),
  `ensureDataLayout()` falls back to a real local `data/raw` directory and
  logs a warning, so the bot still runs off-Windows.
- **`WebFetch` failure:** report plainly; offer to ingest a saved copy if the
  operator drops the file instead.
- **Unreadable binary:** write the `_meta` sidecar rather than fabricating
  content.

## Testing

- `bootstrap`: `<new_sources>` lists only top-level files newer than `log.md`;
  nested files and old files are excluded. `<raw_folders>` renders a 2-level
  tree with the per-folder cap.
- `scaffold`: `ensureDataLayout()` creates the `data/raw` symlink to the
  configured target; idempotent on re-run; local-dir fallback when the target
  parent is absent.
- `telegram`: attachment extraction maps each Telegram kind to a `raw/` save;
  oversized guard triggers the warning path and skips download.
- `typecheck` + `npm test` green before claiming done.

## Open questions

None blocking. Topic-folder naming is left to the agent's judgement by design
(the operator chose "bot decides topic folders"); `<raw_folders>` keeps it
consistent over time.
