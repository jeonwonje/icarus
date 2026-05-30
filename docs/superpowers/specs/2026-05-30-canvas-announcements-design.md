# Canvas announcements + attachments sync

**Date:** 2026-05-30
**Status:** Approved, ready for implementation
**Builds on:** `2026-05-30-canvas-sync-design.md`

## Problem

The Canvas sync mirrors **Files** only. Course **announcements** (and any files
attached to them) aren't synced, so the agent can't see course updates.

## Goal / non-goals

- **Goal:** mirror each course's announcements as read-only markdown under
  `raw/canvas/<course>/announcements/`, plus their downloadable attachments.
- **Non-goal:** discussion replies/threads, non-announcement discussion topics,
  announcement comments.

## Canvas API (verified against NUS)

- `GET /api/v1/courses/:id/discussion_topics?only_announcements=true&per_page=100`
  — paginated (Link `rel="next"`), Bearer. Fields used: `id`, `title`,
  `posted_at`, `message` (HTML), `user_name`, `html_url`, `attachments`.
- An announcement's `attachments[]` are **File objects** (same shape as course
  files: `id`, `display_name`, `url`, `size`, `updated_at`, `locked_for_user`).
  Confirmed: when `locked_for_user` is true the `url` is empty (not
  downloadable); when false the `url` is a signed link that downloads with the
  Bearer header (200). So: download attachments with a non-empty `url`, skip the
  rest.

## Output layout

```
raw/canvas/<course>/announcements/
  2026-04-26-Peer Appraisal.md                         # the announcement
  2026-04-26-Peer Appraisal--Rubric.pdf                # its attachment(s)
```

- Announcement markdown = a header (`# title`, posted date, author, source URL),
  the body with **HTML stripped to readable text**, and an `## Attachments` list
  (the `--`-prefixed filenames) when present.
- Attachments are grouped lexically next to their `.md` via the
  `<slug>--<name>` naming (no subfolders, no collisions).
- All files read-only (`0o444`), already covered by the sandbox `--ro-bind` over
  `raw/canvas`.

## Components (all in `src/canvas.ts`)

Pure helpers (unit-tested):
- `htmlToText(html: string): string` — `<br>`/`</p>`/`</div>` → newline, strip
  remaining tags, decode `&nbsp; &amp; &lt; &gt; &quot; &#39; &apos;`, collapse
  3+ blank lines, trim. Dependency-free.
- `announcementSlug(a): string` — `${posted_at.slice(0,10) || 'undated'}-${sanitizeName(title || 'untitled')}`.
- `renderAnnouncement(a, attachmentNames: string[]): string` — the markdown.

Client:
- `listCourseAnnouncements(cfg, courseId): Promise<Announcement[]>` — paginated
  (reuses `getPaged`). Announcements are kept regardless of lock state (metadata
  is still useful); attachment access is filtered at download time.

Type:
- `Announcement { id: number; title?: string; posted_at?: string; message?: string; user_name?: string; html_url?: string; attachments?: CanvasFile[] }`

`syncCanvas` — after the files pass, per course:
1. `listCourseAnnouncements`; ensure `announcements/` dir.
2. For each announcement, `slug = announcementSlug(a)`:
   - Determine attachment targets: `a.attachments` with a non-empty `url`, not
     `locked_for_user`, and `size <= maxBytes`. Their on-disk names are
     `${slug}--${sanitizeName(att.display_name)}`.
   - Announcement `.md` at `announcements/${slug}.md`. `needsDownload` keyed
     `ann:<id>` on `posted_at`; if changed/missing → render (listing the
     attachment names) → `writeReadOnly` → manifest `ann:<id> = {updated_at: posted_at, path}`
     → persist → `summary.announcements++`, else `summary.skipped++`.
   - For each attachment target: `needsDownload` keyed `att:<id>` on
     `updated_at`; if needed → download via its `url` → `writeReadOnly` →
     manifest `att:<id>` → persist → `summary.downloaded++`, `bytes += len`, else
     `summary.skipped++`. Oversized → `skipped++`. Per-attachment errors →
     `failed++` (isolated, like files).

Manifest keys are namespaced (`ann:`, `att:`) so they can't collide with the
bare file ids already in the manifest.

## Summary / reply

`SyncSummary` gains `announcements: number`. The `/canvas` reply becomes:
`Canvas: ${downloaded} new files, ${announcements} new announcements, ${skipped} unchanged, ${failed} failed across ${courses} courses · ${MB} MB`.
(`downloaded`/`bytes` count course files **and** announcement attachments.)

## Error handling

- Announcement list 403/non-ok for a course → caught per-course (existing), counted `failed`, sync continues.
- Locked / url-less attachment → not a target; silently omitted (it isn't a failure).
- Oversized attachment → `skipped` + logged (reuses the files cap).
- Per-attachment download error → `failed`, others continue.
- Missing `posted_at`/`title` → `undated` / `untitled` slug; never escapes the dir (sanitized).

## Testing (TDD)

`test/canvas.test.ts`:
- `htmlToText`: tags stripped, `<br>`/`</p>` → newlines, entities decoded, blank
  lines collapsed.
- `announcementSlug`: date + sanitized title; missing date → `undated-…`;
  missing title → `…-untitled`.
- `renderAnnouncement`: contains title, author, stripped body; lists attachment
  names; omits the Attachments section when none.
- `listCourseAnnouncements`: aggregates paginated pages.
- `syncCanvas` announcements: injected fetch (courses + empty files + one
  announcement carrying one downloadable + one locked attachment) → writes the
  `.md` (mode `0o444`, `ann:` manifest key), downloads only the unlocked
  attachment (named `slug--name`, `att:` key), skips the locked one, increments
  `announcements`/`downloaded`; a second run skips everything.

## Docs

- `CLAUDE.md`: note announcements (+ attachments) are mirrored read-only under
  `raw/canvas/<course>/announcements/`.
