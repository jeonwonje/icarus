import fs from 'node:fs';
import path from 'node:path';

// ── Canvas REST client (dependency-free: Node fs/path + global fetch) ──────────

/** GET a Canvas collection, following the RFC5988 Link `rel="next"` chain. */
async function getPaged(cfg, startUrl) {
  const doFetch = cfg.fetchImpl ?? fetch;
  const out = [];
  let url = startUrl;
  while (url) {
    const res = await doFetch(url, { headers: { Authorization: `Bearer ${cfg.token}` } });
    if (!res.ok) throw new Error(`Canvas ${res.status} for ${url}`);
    out.push(...(await res.json()));
    url = parseNextLink(res.headers.get('link'));
  }
  return out;
}

/** The operator's active-enrollment courses. */
export function listActiveCourses(cfg) {
  return getPaged(cfg, `${cfg.baseUrl}/api/v1/courses?enrollment_state=active&per_page=100`);
}

/** Files in a course, excluding ones the user can't access. */
export async function listCourseFiles(cfg, courseId) {
  const files = await getPaged(cfg, `${cfg.baseUrl}/api/v1/courses/${courseId}/files?per_page=100`);
  return files.filter((f) => !f.locked_for_user);
}

/** A course's announcements (newest-first as Canvas returns them). */
export function listCourseAnnouncements(cfg, courseId) {
  return getPaged(
    cfg,
    `${cfg.baseUrl}/api/v1/courses/${courseId}/discussion_topics?only_announcements=true&per_page=100`,
  );
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

/** Extract the `rel="next"` URL from an RFC5988 Link header, or null. */
export function parseNextLink(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="?next"?/);
    if (m) return m[1];
  }
  return null;
}

/**
 * Make a single safe path segment: separators replaced, control chars stripped,
 * never `.` or `..`, surrounding whitespace trimmed. Falls back to `file`.
 */
export function sanitizeName(name) {
  const s = (name ?? '')
    .replace(/[/\\]/g, '_')
    .replace(/\p{Cc}/gu, '')
    .trim();
  if (s === '' || s === '.' || s === '..') return 'file';
  return s;
}

/** Directory name for a course: lowercased code, else name, else course-<id>. */
export function courseDirName(c) {
  const raw = c.course_code || c.name || `course-${c.id}`;
  return sanitizeName(raw).toLowerCase();
}

/** Whether a course passes the `;`-separated allowlist (empty = all). */
export function courseAllowed(c, filter) {
  const wanted = (filter ?? '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  if (wanted.length === 0) return true;
  return wanted.includes(String(c.id)) || (c.course_code ? wanted.includes(c.course_code) : false);
}

/** True when a file must be (re)downloaded given its manifest entry + presence. */
export function needsDownload(file, entry, localExists) {
  if (!localExists || !entry) return true;
  return entry.updated_at !== file.updated_at;
}

/** Convert announcement HTML to readable plain text (dependency-free). */
export function htmlToText(html) {
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

/** `<date>-<sanitized title>` slug for an announcement's filenames. */
export function announcementSlug(a) {
  const date = (a.posted_at ?? '').slice(0, 10) || 'undated';
  return `${date}-${sanitizeName(a.title || 'untitled')}`;
}

/** Render an announcement as markdown, listing its attachment filenames. */
export function renderAnnouncement(a, attachmentNames) {
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

// ── Download + write ──────────────────────────────────────────────────────────

const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const READ_ONLY = 0o444;
const OWNER_WRITE = 0o644;

function loadManifest(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return {};
  }
}

async function downloadFile(cfg, url) {
  const doFetch = cfg.fetchImpl ?? fetch;
  const res = await doFetch(url, { headers: { Authorization: `Bearer ${cfg.token}` } });
  if (!res.ok) throw new Error(`download ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Write `buf` to `dest` as a read-only file, clearing a prior read-only bit.
 * Async so large writes to slow (drvfs) storage don't stall the event loop.
 */
async function writeReadOnly(dest, buf) {
  if (fs.existsSync(dest)) await fs.promises.chmod(dest, OWNER_WRITE);
  await fs.promises.writeFile(dest, buf);
  await fs.promises.chmod(dest, READ_ONLY);
}

// ── Hub resolution + sync ───────────────────────────────────────────────────

/** Resolve the hub root: explicit arg, else walk up to a `.claude`/`CLAUDE.md`, else cwd. */
export function resolveHubDir(arg, cwd = process.cwd()) {
  if (arg) return path.resolve(arg);
  let dir = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.claude')) || fs.existsSync(path.join(dir, 'CLAUDE.md'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(cwd);
}

/**
 * Mirror active Canvas courses into `<hub>/academic/<course>/canvas/` (read-only
 * files + announcements) and ensure a sibling `user/` dir. Idempotent via
 * `<hub>/academic/.canvas-manifest.json`. Per-file/course failures are counted.
 */
export async function syncCanvas(cfg, opts) {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const summary = { courses: 0, downloaded: 0, announcements: 0, skipped: 0, failed: 0, bytes: 0, errors: [] };

  const academicDir = path.join(opts.hubDir, 'academic');
  fs.mkdirSync(academicDir, { recursive: true });
  const manifestPath = path.join(academicDir, '.canvas-manifest.json');
  const manifest = loadManifest(manifestPath);
  const persist = () => fs.promises.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  const rel = (p) => path.relative(academicDir, p);

  const courses = (await listActiveCourses(cfg)).filter((c) => courseAllowed(c, opts.coursesFilter ?? ''));
  summary.courses = courses.length;

  for (const course of courses) {
    const base = path.join(academicDir, courseDirName(course));
    const canvasDir = path.join(base, 'canvas');
    try {
      fs.mkdirSync(canvasDir, { recursive: true });
      fs.mkdirSync(path.join(base, 'user'), { recursive: true });

      const files = await listCourseFiles(cfg, course.id);
      for (const file of files) {
        if (file.size > maxBytes) {
          summary.skipped++;
          console.warn(`skip oversized: ${file.display_name} (${file.size})`);
          continue;
        }
        const dest = path.join(canvasDir, sanitizeName(file.display_name));
        if (!needsDownload(file, manifest[file.id], fs.existsSync(dest))) {
          summary.skipped++;
          continue;
        }
        try {
          const buf = await downloadFile(cfg, file.url);
          await writeReadOnly(dest, buf);
          manifest[file.id] = { updated_at: file.updated_at, path: rel(dest) };
          await persist();
          summary.downloaded++;
          summary.bytes += buf.length;
        } catch (err) {
          summary.failed++;
          summary.errors.push(`${courseDirName(course)}/${file.display_name}: ${err.message}`);
        }
      }

      const anns = await listCourseAnnouncements(cfg, course.id);
      const annDir = path.join(canvasDir, 'announcements');
      if (anns.length) fs.mkdirSync(annDir, { recursive: true });
      for (const ann of anns) {
        const slug = announcementSlug(ann);
        const targets = (ann.attachments ?? []).filter((f) => f.url && !f.locked_for_user && f.size <= maxBytes);
        const attachNames = targets.map((f) => `${slug}--${sanitizeName(f.display_name)}`);

        const mdDest = path.join(annDir, `${slug}.md`);
        if (needsDownload({ updated_at: ann.posted_at ?? '' }, manifest[`ann:${ann.id}`], fs.existsSync(mdDest))) {
          await writeReadOnly(mdDest, Buffer.from(renderAnnouncement(ann, attachNames), 'utf-8'));
          manifest[`ann:${ann.id}`] = { updated_at: ann.posted_at ?? '', path: rel(mdDest) };
          await persist();
          summary.announcements++;
        } else {
          summary.skipped++;
        }

        for (const att of targets) {
          const dest = path.join(annDir, `${slug}--${sanitizeName(att.display_name)}`);
          if (!needsDownload(att, manifest[`att:${att.id}`], fs.existsSync(dest))) {
            summary.skipped++;
            continue;
          }
          try {
            const buf = await downloadFile(cfg, att.url);
            await writeReadOnly(dest, buf);
            manifest[`att:${att.id}`] = { updated_at: att.updated_at, path: rel(dest) };
            await persist();
            summary.downloaded++;
            summary.bytes += buf.length;
          } catch (err) {
            summary.failed++;
            summary.errors.push(`${courseDirName(course)}/announcements/${att.display_name}: ${err.message}`);
          }
        }
      }
    } catch (err) {
      summary.failed++;
      summary.errors.push(`${courseDirName(course)}: ${err.message}`);
    }
  }

  await persist();
  return summary;
}

async function main() {
  const token = process.env.CANVAS_API_TOKEN;
  if (!token) {
    console.error('CANVAS_API_TOKEN not set (export it in ~/.bashrc).');
    process.exit(1);
  }
  const baseUrl = process.env.CANVAS_BASE_URL || 'https://canvas.nus.edu.sg';
  const hubDir = resolveHubDir(process.argv[2]);
  console.error(`canvas sync → ${path.join(hubDir, 'academic')}`);
  const s = await syncCanvas({ baseUrl, token }, { hubDir, coursesFilter: process.env.CANVAS_COURSES || '' });
  console.log(
    `Canvas: ${s.downloaded} new files, ${s.announcements} new announcements, ${s.skipped} unchanged, ${s.failed} failed across ${s.courses} courses · ${(s.bytes / 1e6).toFixed(1)} MB`,
  );
  for (const e of s.errors.slice(0, 10)) console.error(`  ✗ ${e}`);
  if (s.failed > 0 && s.downloaded === 0 && s.announcements === 0) process.exit(1);
}

// Run only when executed directly (not when imported by tests).
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main();
}
