# Canvas Announcements Implementation Plan

> TDD, task-by-task. Steps use `- [ ]`.

**Goal:** Mirror course announcements (markdown) + their accessible attachments into read-only `raw/canvas/<course>/announcements/`.

**Architecture:** Extend `src/canvas.ts` with `htmlToText`/`announcementSlug`/`renderAnnouncement` (pure), `listCourseAnnouncements` (paginated), and an announcements pass in `syncCanvas`. Reuses `downloadFile`/`writeReadOnly`/manifest. Namespaced manifest keys `ann:`/`att:`.

---

### Task 1: pure helpers (htmlToText, announcementSlug, renderAnnouncement)

**Files:** `src/canvas.ts`, `test/canvas.test.ts`

- [ ] **Tests first:**
  - `htmlToText('<p>Hi&nbsp;there</p><br><div>x &amp; y</div>')` → `'Hi there\n\nx & y'` (tags→newlines for block/br, entities decoded, trimmed, no 3+ blank runs). Assert: contains `'Hi there'`, `'x & y'`, no `'<'`.
  - `announcementSlug({posted_at:'2026-04-26T10:55:20Z', title:'Peer/Appraisal'})` → `'2026-04-26-Peer_Appraisal'`; missing posted_at → starts `'undated-'`; missing title → ends `'-untitled'`.
  - `renderAnnouncement({title:'T', posted_at:'2026-04-26T10:55:20Z', user_name:'A', html_url:'U', message:'<p>Body</p>'}, ['x.pdf'])` → contains `'# T'`, `'A'`, `'Body'`, `'## Attachments'`, `'x.pdf'`. With `[]` → no `'## Attachments'`.
- [ ] **Implement** in `src/canvas.ts`:
  ```typescript
  export interface Announcement {
    id: number;
    title?: string;
    posted_at?: string;
    message?: string;
    user_name?: string;
    html_url?: string;
    attachments?: CanvasFile[];
  }

  export function htmlToText(html: string): string {
    return (html ?? '')
      .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6])\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  export function announcementSlug(a: Announcement): string {
    const date = (a.posted_at ?? '').slice(0, 10) || 'undated';
    return `${date}-${sanitizeName(a.title || 'untitled')}`;
  }

  export function renderAnnouncement(a: Announcement, attachmentNames: string[]): string {
    const lines = [
      `# ${a.title ?? 'Untitled'}`,
      '',
      `- Posted: ${a.posted_at ?? 'unknown'}`,
      `- Author: ${a.user_name ?? 'unknown'}`,
      `- Source: ${a.html_url ?? ''}`,
      '',
      htmlToText(a.message ?? ''),
    ];
    if (attachmentNames.length) {
      lines.push('', '## Attachments', ...attachmentNames.map((n) => `- ${n}`));
    }
    return lines.join('\n') + '\n';
  }
  ```
- [ ] `npm test -- canvas`, `npm run typecheck`. **Commit** `feat(canvas): announcement render helpers`.

---

### Task 2: listCourseAnnouncements

**Files:** `src/canvas.ts`, `test/canvas.test.ts`

- [ ] **Test:** injected fetch, 2 pages via Link header for
  `/courses/:id/discussion_topics?only_announcements=true` → aggregates both pages.
- [ ] **Implement:**
  ```typescript
  export function listCourseAnnouncements(cfg: CanvasConfig, courseId: number): Promise<Announcement[]> {
    return getPaged<Announcement>(
      cfg,
      `${cfg.baseUrl}/api/v1/courses/${courseId}/discussion_topics?only_announcements=true&per_page=100`,
    );
  }
  ```
- [ ] `npm test -- canvas`, typecheck. **Commit** `feat(canvas): list course announcements`.

---

### Task 3: announcements pass in syncCanvas

**Files:** `src/canvas.ts`, `test/canvas.test.ts`

- [ ] **Add** `announcements: number` to `SyncSummary` (init 0).
- [ ] **Implement** after the files loop, inside the per-course `try` (so a failing announcement list is caught per-course):
  ```typescript
  const annDir = path.join(courseDir, 'announcements');
  const anns = await listCourseAnnouncements(cfg, course.id);
  if (anns.length) fs.mkdirSync(annDir, { recursive: true });
  for (const ann of anns) {
    const slug = announcementSlug(ann);
    const targets = (ann.attachments ?? []).filter(
      (f) => f.url && !f.locked_for_user && f.size <= maxBytes,
    );
    const attachNames = targets.map((f) => `${slug}--${sanitizeName(f.display_name)}`);
    // announcement markdown
    const mdDest = path.join(annDir, `${slug}.md`);
    const annEntry = manifest[`ann:${ann.id}`];
    if (needsDownload({ updated_at: ann.posted_at ?? '' }, annEntry, fs.existsSync(mdDest))) {
      await writeReadOnly(mdDest, Buffer.from(renderAnnouncement(ann, attachNames), 'utf-8'));
      manifest[`ann:${ann.id}`] = { updated_at: ann.posted_at ?? '', path: path.relative(opts.canvasDir, mdDest) };
      await persistManifest();
      summary.announcements++;
    } else {
      summary.skipped++;
    }
    // attachments
    for (const att of targets) {
      const dest = path.join(annDir, `${slug}--${sanitizeName(att.display_name)}`);
      if (!needsDownload(att, manifest[`att:${att.id}`], fs.existsSync(dest))) {
        summary.skipped++;
        continue;
      }
      try {
        const buf = await downloadFile(cfg, att.url);
        await writeReadOnly(dest, buf);
        manifest[`att:${att.id}`] = { updated_at: att.updated_at, path: path.relative(opts.canvasDir, dest) };
        await persistManifest();
        summary.downloaded++;
        summary.bytes += buf.length;
      } catch (err) {
        summary.failed++;
        summary.errors.push(`${courseDirName(course)}/announcements/${att.display_name}: ${(err as Error).message}`);
      }
    }
  }
  ```
- [ ] **Tests** (tmp dir + fake fetch serving courses, empty files, one announcement with one downloadable + one locked attachment):
  - `.md` written at `announcements/<slug>.md`, mode `0o444`, manifest has `ann:<id>`.
  - the unlocked attachment downloaded as `<slug>--<name>`, mode `0o444`, manifest `att:<id>`; the locked one (no url) absent.
  - `summary.announcements===1`, `summary.downloaded===1`.
  - second run → `announcements:0`, attachments skipped.
- [ ] `npm test`, typecheck. **Commit** `feat(canvas): sync announcements + attachments`.

---

### Task 4: reply + docs

**Files:** `src/admin-commands.ts`, `scripts/canvas-sync.ts`, `CLAUDE.md`

- [ ] Update the `/canvas` reply string (in `handleCanvas`) and the script's
  console summary to include `${s.announcements} new announcements`.
- [ ] `CLAUDE.md`: note announcements + attachments mirrored read-only under
  `raw/canvas/<course>/announcements/`.
- [ ] `npm test`, typecheck. **Commit** `feat(canvas): report announcements in /canvas + docs`.

---

### Task 5: live verification

- [ ] One-off tsx: `syncCanvas` for a course known to have announcements (e.g. id 85250) into a tmp dir; assert `.md` files written read-only and `announcements>0`; for course 57331 assert the unlocked attachment downloads and locked ones are skipped. Then deploy (merge → build → restart).

---

## Self-Review
- Announcement md, attachments (accessible only), manifest namespacing, summary, reply, docs, tests → Tasks 1–4 map to spec sections. ✓
- Types: `Announcement`, `htmlToText`, `announcementSlug`, `renderAnnouncement`, `listCourseAnnouncements`, `SyncSummary.announcements`. ✓
- No placeholders; concrete code + test intents. ✓
