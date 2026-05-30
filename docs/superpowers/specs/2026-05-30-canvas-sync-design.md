# NUS Canvas read-only sync into raw/

**Date:** 2026-05-30
**Status:** Approved (operator pre-approved recommended defaults), ready for implementation
**Builds on:** the agent sandbox + `SANDBOX_MOUNTS` work.

## Problem

The operator wants Canvas (NUS, `canvas.nus.edu.sg`) course files mirrored into
the bot's `raw/` tree so the life agent can read and cite them. The mirrored
files must be **read-only**: they are authoritative source material and the
sandboxed agent must not modify them. Triggered inline from Telegram while the
service runs.

## Goal / non-goals

- **Goal:** sync files from the operator's active Canvas courses into
  `data/raw/canvas/<course>/<file>`, read-only, idempotently.
- **Goal:** a `/canvas` Telegram command that runs the sync inline and reports a
  summary; also a standalone script runner.
- **Goal:** the Canvas token never reaches the sandboxed `claude` subprocess.
- **Non-goal:** uploading to Canvas, assignments/submissions, announcements,
  incremental webhooks, two-way sync.

## Canvas API (verified against NUS + Context7)

- Auth: `Authorization: Bearer <token>`.
- Courses: `GET /api/v1/courses?enrollment_state=active&per_page=100` →
  `{id, course_code, name}`.
- Files: `GET /api/v1/courses/:id/files?per_page=100` → File objects with
  `id, display_name, url, size, updated_at, locked_for_user`. `url` is a direct
  download link (verifier-signed); we still send the Bearer header.
- Pagination: RFC5988 `Link` header with `rel="next"` (verified present).

## Config (`.env`, gitignored — token is a secret)

- `CANVAS_BASE_URL` (default `https://canvas.nus.edu.sg`)
- `CANVAS_API_TOKEN` (secret; required for sync, absent → `/canvas` reports "not
  configured")
- `CANVAS_COURSES` (optional; `;`-separated course_code or id allowlist; empty =
  all active)

## Components

### `src/canvas.ts` — client + sync engine

Pure, unit-testable helpers:
- `parseNextLink(linkHeader: string | null): string | null` — extract the
  `rel="next"` URL, or null.
- `sanitizeName(name: string): string` — strip path separators and control
  chars, reject `.`/`..`, collapse whitespace; fallback `'file'` if empty.
- `courseDirName(c: {course_code?: string; name?: string; id: number}): string`
  — sanitized `course_code`, else sanitized `name`, else `course-<id>`.
- `needsDownload(file, manifestEntry, localExists): boolean` — true when local
  missing, no manifest entry, or `file.updated_at` differs.

HTTP layer (fetch injected via `opts.fetch`, defaults to global `fetch`):
- `listActiveCourses(cfg): Promise<Course[]>` — paginated via `parseNextLink`.
- `listCourseFiles(cfg, courseId): Promise<CanvasFile[]>` — paginated; drops
  `locked_for_user` files.
- `syncCanvas(cfg, opts): Promise<SyncSummary>` — orchestrates: ensure
  `raw/canvas/`, load manifest, for each course (filtered by `CANVAS_COURSES`)
  list files, download each needing update into
  `raw/canvas/<course>/<display_name>`, `chmod 0o444`, update manifest. Skips
  files over `maxBytes`. Per-file failures are caught and counted, not fatal.
  Returns `{courses, downloaded, skipped, failed, bytes, errors: string[]}`.

Manifest: `raw/canvas/.manifest.json` = `{ [fileId]: { updated_at, path } }`.
Stays writable (metadata, not chmod'd). Lets re-runs skip unchanged files.

### Read-only enforcement (two layers)

1. **`chmod 0o444`** on every downloaded file — verified honored on the drvfs
   Desktop (`raw/`). Protects against casual writes, incl. from Windows.
2. **Sandbox read-only bind** — `buildSandboxArgs` gains `readOnlyMounts?:
   string[]`, appended as `--ro-bind-try <p> <p>` *after* the read-write binds so
   the subpath is read-only inside the sandbox regardless of file perms.
   `agent-runner` passes `[path.join(rawTarget, 'canvas')]` when sandboxing. The
   sync itself runs in the (unsandboxed) bot process, so it can still write.

### Token isolation

The systemd unit loads all of `.env` via `EnvironmentFile`, so `process.env`
holds the secrets, and `agent-runner` currently spawns `claude` with
`env: {...process.env}` — leaking `CANVAS_API_TOKEN` (and `TELEGRAM_BOT_TOKEN`)
into the sandboxed agent. Add a small denylist scrub: strip
`CANVAS_API_TOKEN`, `TELEGRAM_BOT_TOKEN`, `OPERATOR_USER_ID` from the env passed
to the `claude` subprocess. `claude` needs none of them (its Anthropic auth
lives in `~/.claude`).

### `/canvas` command — `src/admin-commands.ts`

Runs in the bot's node process (not the agent), so the token never reaches
`claude`. Calls `syncCanvas` and returns a summary reply
(`Synced N files (M skipped, F failed) from C courses · X MB`). If
`CANVAS_API_TOKEN` is unset → "Canvas not configured." Runs to completion before
replying (acceptable for a single-operator bot; long first sync just waits).
Added to `/help`.

### `scripts/canvas-sync.ts` — standalone runner

Mirrors `scripts/weekly-prune.ts`: load config, run `syncCanvas`, log the
summary. Lets the sync be cron'd later.

### No change to bootstrap

`raw/canvas/<course>/` surfaces in `<raw_folders>` automatically via the
existing `listRawTree` (it lists real dirs).

## Data flow

```
/canvas (Telegram)
  -> admin-commands.handleCanvas (node process)
  -> syncCanvas(cfg): list active courses -> per course list files
       -> for each changed file: GET url (Bearer) -> write raw/canvas/<c>/<f>
          -> chmod 0o444 -> manifest[id] = {updated_at, path}
  -> reply summary to Telegram
Next agent turn: claude (sandboxed) sees raw/canvas/* READ-ONLY (ro-bind).
```

## Error handling

- Missing token → command reports "not configured"; sync is a no-op.
- Non-2xx from Canvas (course/file list) → throw, surfaced as the command's
  error reply; partial per-file download failures are caught + counted.
- Oversized file (> `maxBytes`, default 100 MB) → skipped, logged.
- Unsafe filename → sanitized; never escapes `raw/canvas/<course>/`.
- Network/timeout per file → counted in `failed`, sync continues.

## Testing (TDD)

`test/canvas.test.ts`:
- `parseNextLink`: extracts next; null when only `current`/absent.
- `sanitizeName`: strips `/`, rejects `..`, keeps spaces+extension, fallback.
- `courseDirName`: code > name > `course-<id>`.
- `needsDownload`: missing/changed → true; unchanged → false.
- `listActiveCourses`/`listCourseFiles`: injected fetch with 2 pages + Link
  header → aggregates; `locked_for_user` dropped.
- `syncCanvas`: injected fetch + tmp dir → downloads, sets mode `0o444`, writes
  manifest; second run skips unchanged; oversized skipped; a failing download is
  counted, others still succeed.

`test/sandbox.test.ts`:
- `buildSandboxArgs` with `readOnlyMounts` → `--ro-bind-try p p` present and
  positioned after the `--bind` for `dataDir`/`rawTarget`.

`test/agent-runner` (or a focused unit): env scrub removes the secret keys.
(If `agent-runner` has no existing test seam, assert via a small exported pure
helper `scrubSecretEnv(env): env`.)

Live sync verified manually against NUS before deploy.

## Security

- Token only in gitignored `.env`; never committed, never sent to Context7 or
  the agent. Scrubbed from the `claude` env.
- Downloaded files read-only at both fs (chmod) and sandbox (ro-bind) layers.
- `CANVAS_COURSES` lets the operator scope what's mirrored.

## Docs

- `.env.example`: `CANVAS_BASE_URL`, `CANVAS_API_TOKEN`, `CANVAS_COURSES` with a
  secret warning.
- `CLAUDE.md`: note the `/canvas` command and the read-only `raw/canvas/` mirror.
