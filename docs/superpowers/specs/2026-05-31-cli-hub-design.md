# icarus → Claude Code CLI hub + data-source skills

**Date:** 2026-05-31
**Status:** Approved, ready for implementation

## Problem

icarus is a Telegram bot that bridges DMs to the `claude` CLI. Almost all of its
code exists only for that bridge. The operator wants the **primary interface to
be the Claude Code CLI itself** — run `claude` in their OneDrive and work by
typing — with the repo reduced to an **extensible library of data-source
skills** (Canvas first, others later). No bot, no orchestrator, no sandbox.

## Target architecture

### The hub = OneDrive

Run `claude` inside `/mnt/c/Users/jeonw/OneDrive - National University of Singapore`.
Claude Code reads the persona from `<hub>/CLAUDE.md` and discovers skills from
`<hub>/.claude/skills/`. Life is organized by domain/subject:

```
<hub>/
  CLAUDE.md                         # persona (moved out of the repo)
  wiki/                             # knowledge notes (moved out of the repo)
  .claude/skills/  ── symlink ─▶ <repo>/skills
  academic/
    me2112/
      canvas/                       # read-only Canvas mirror (chmod 0444)
        announcements/
      user/                         # operator + agent working files
  academic/.canvas-manifest.json    # dedup manifest, keyed by file/ann/att id
```

Only `academic/*/canvas/` is sync-managed and read-only. Other domains
(`personal/`, `finance/`, …) and every `user/` dir are freely agent/operator
managed.

### Data sources = Claude Code Skills (the repo)

The repo becomes a **skill library**, symlinked into the hub:

```
<repo>/
  skills/
    canvas/
      SKILL.md
      scripts/sync.mjs
      scripts/sync.test.mjs
    _template/                      # starter to copy for a new source
      SKILL.md
      scripts/sync.mjs
  package.json                      # vitest only (tests for the .mjs)
  README.md                         # how to use the hub + add a source
  docs/superpowers/...              # specs + plans
```

- `<repo>/skills` is symlinked to `<hub>/.claude/skills`, so the CLI
  auto-discovers every skill (verified: project skills load from
  `.claude/skills/<name>/SKILL.md`; `${CLAUDE_SKILL_DIR}` resolves the skill's
  own dir; symlinks work through drvfs).
- Adding a source = copy `_template/` to `skills/<source>/`, fill in SKILL.md +
  sync.mjs. Already linked into the hub.

### The canvas skill

`skills/canvas/SKILL.md` frontmatter:
```yaml
---
name: canvas
description: Sync NUS Canvas course files and announcements into academic/<course>/canvas (read-only). Use when the operator asks to sync/refresh/pull Canvas.
---
```
Body instructs: run `node ${CLAUDE_SKILL_DIR}/scripts/sync.mjs` from the hub root
(the script resolves the hub itself; see below). Invocable via auto-trigger
("sync my canvas") or `/canvas`.

`scripts/sync.mjs` — **dependency-free** (Node `fs`, `path`, global `fetch`),
ported from today's `src/canvas.ts`:
- Reads `CANVAS_API_TOKEN` (required) and `CANVAS_BASE_URL`
  (default `https://canvas.nus.edu.sg`) from the **environment** (exported in
  `~/.bashrc`; never in OneDrive or git). Exits with a clear message if the
  token is unset.
- Resolves the **hub root**: first CLI arg if given, else walk up from
  `process.cwd()` to the nearest dir containing `.claude/` or `CLAUDE.md`, else
  `process.cwd()`.
- Lists active courses (`courseAllowed` honors an optional `CANVAS_COURSES`
  allowlist), then per course: files + announcements (+ accessible attachments),
  manifest dedup (`<hub>/academic/.canvas-manifest.json`), writes into
  `<hub>/academic/<course>/canvas/` (course = lowercased, sanitized
  `course_code`), `chmod 0o444`, ensures the sibling `user/` dir, incremental
  manifest persistence, async writes.
- Prints a one-line summary; per-file/course errors are counted, not fatal.

Carried over verbatim from `canvas.ts` (now in `.mjs`): `parseNextLink`,
`sanitizeName`, `courseDirName`, `courseAllowed`, `needsDownload`,
`htmlToText`, `announcementSlug`, `renderAnnouncement`, paginated
`listActiveCourses`/`listCourseFiles`/`listCourseAnnouncements`, `downloadFile`,
`writeReadOnly`, and `syncCanvas` (re-targeted to the hub layout).

### Read-only

`chmod 0o444` on every synced canvas file/attachment (drvfs honors it — write
bit cleared). The bwrap sandbox is removed; there is no untrusted remote agent
anymore (the operator runs claude and approves tool use), so chmod is the
appropriate guard for "don't clobber the authoritative mirror."

## Teardown (the "less code")

Delete the entire Telegram bridge and its support:
- `src/`: `index.ts`, `telegram.ts`, `agent-runner.ts`, `agent-types.ts`,
  `db.ts`, `mutex.ts`, `admin-commands.ts`, `sandbox.ts`, `slug.ts`, `config.ts`,
  `env.ts`, `logger.ts`, all of `src/memory/*`, and `src/canvas.ts` (its logic
  moves to the skill `.mjs`). The whole `src/` tree goes.
- `scripts/weekly-prune.ts`; `data/` (after migrating its contents); custom
  skills under `data/skills/`.
- `test/`: everything except a ported sync test (which moves to
  `skills/canvas/scripts/sync.test.mjs`).
- `systemd/`: `icarus.service`, `icarus-prune.service`, `icarus-prune.timer` —
  stop + disable + remove the unit files; the running bot is shut down.
- `package.json` deps: remove `grammy`, `@grammyjs/runner`, `better-sqlite3`,
  `@types/better-sqlite3`, `pino`, `pino-pretty` (logger no longer used).
  Remove `typescript`/`tsx` if no TS remains (skills are `.mjs`); keep `vitest`
  + `@types/node`. Scripts trimmed to `{ test: "vitest run" }`.
- `tsconfig.json` removed if no TS remains.

Git history preserves all deleted code.

## Migration (operator's real data)

1. Move tracked persona `data/CLAUDE.md` → `<hub>/CLAUDE.md`, adapted for CLI
   use: drop Telegram/bot framing; describe the hub layout, the `canvas`
   read-only / `user` convention, and that knowledge lives in `wiki/`.
2. Move `data/wiki/` (+ `index.md`) → `<hub>/wiki/`.
3. `~/.bashrc`: `export CANVAS_API_TOKEN=…` and `CANVAS_BASE_URL` (done).
4. Symlink `<repo>/skills` → `<hub>/.claude/skills`.
5. Fresh canvas sync into `<hub>/academic/` (new manifest). The old
   `~/Desktop/icarus-raw` mirror is abandoned; operator deletes it afterward.

## Error handling

- Missing `CANVAS_API_TOKEN` → script prints "set CANVAS_API_TOKEN in ~/.bashrc"
  and exits non-zero.
- Hub root not found → falls back to `process.cwd()` with a warning.
- Canvas API non-ok / locked items / oversized files / per-file errors →
  handled exactly as today (counted, not fatal); locked attachments skipped.

## Testing (TDD)

`skills/canvas/scripts/sync.test.mjs` (vitest, importing the `.mjs`):
- Port the existing pure-helper + client + `syncCanvas` tests (parseNextLink,
  sanitizeName, courseDirName, courseAllowed, needsDownload, htmlToText,
  announcementSlug, renderAnnouncement, paginated list*, syncCanvas file +
  announcement + attachment behavior with injected `fetch`, read-only mode,
  manifest dedup, incremental persistence).
- New: hub-root resolution (arg, walk-up to `.claude`/`CLAUDE.md`, cwd fallback)
  and the `academic/<course>/{canvas,user}` target layout.

`npm test` (vitest) green; the skill is verified live against NUS before
teardown.

## Phasing

1. **Build the canvas skill** — `skills/canvas/{SKILL.md, scripts/sync.mjs,
   scripts/sync.test.mjs}`, dependency-free, env creds, new hub layout, tests
   green, verified live (one course) into a temp hub.
2. **Hub setup + migration** — symlink skills into the hub; move CLAUDE.md +
   wiki into OneDrive (rewrite CLAUDE.md for CLI); full canvas sync into
   `academic/`; confirm `claude` in the hub discovers `/canvas`.
3. **Teardown** — stop/disable/remove services + the running bot, delete the
   bridge code/tests/`data/`, trim `package.json`/deps, remove `tsconfig` if
   unused, add `_template` skill + README ("using the hub" + "adding a data
   source").

## Out of scope

Other data sources (Gmail, Teams, …) — the `_template` + README make them easy
to add later, but only Canvas ships now.
