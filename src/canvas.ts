import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

export interface Course {
  id: number;
  course_code?: string;
  name?: string;
}

export interface ManifestEntry {
  updated_at: string;
  path: string;
}

export interface CanvasConfig {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}

export interface CanvasFile {
  id: number;
  display_name: string;
  url: string;
  size: number;
  updated_at: string;
  locked_for_user?: boolean;
}

/** GET a Canvas collection, following the RFC5988 Link `rel="next"` chain. */
async function getPaged<T>(cfg: CanvasConfig, startUrl: string): Promise<T[]> {
  const doFetch = cfg.fetchImpl ?? fetch;
  const out: T[] = [];
  let url: string | null = startUrl;
  while (url) {
    const res = await doFetch(url, { headers: { Authorization: `Bearer ${cfg.token}` } });
    if (!res.ok) throw new Error(`Canvas ${res.status} for ${url}`);
    out.push(...((await res.json()) as T[]));
    url = parseNextLink(res.headers.get('link'));
  }
  return out;
}

/** The operator's active-enrollment courses. */
export function listActiveCourses(cfg: CanvasConfig): Promise<Course[]> {
  return getPaged<Course>(
    cfg,
    `${cfg.baseUrl}/api/v1/courses?enrollment_state=active&per_page=100`,
  );
}

/** Files in a course, excluding ones the user can't access. */
export async function listCourseFiles(cfg: CanvasConfig, courseId: number): Promise<CanvasFile[]> {
  const files = await getPaged<CanvasFile>(
    cfg,
    `${cfg.baseUrl}/api/v1/courses/${courseId}/files?per_page=100`,
  );
  return files.filter((f) => !f.locked_for_user);
}

/** Extract the `rel="next"` URL from an RFC5988 Link header, or null. */
export function parseNextLink(linkHeader: string | null): string | null {
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
export function sanitizeName(name: string): string {
  const s = (name ?? '')
    .replace(/[/\\]/g, '_')
    .replace(/\p{Cc}/gu, '')
    .trim();
  if (s === '' || s === '.' || s === '..') return 'file';
  return s;
}

/** Directory name for a course: code, else name, else course-<id>; sanitized. */
export function courseDirName(c: Course): string {
  const raw = c.course_code || c.name || `course-${c.id}`;
  return sanitizeName(raw);
}

/** Whether a course passes the `;`-separated allowlist (empty = all). */
export function courseAllowed(c: Course, filter: string): boolean {
  const wanted = (filter ?? '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  if (wanted.length === 0) return true;
  return wanted.includes(String(c.id)) || (c.course_code ? wanted.includes(c.course_code) : false);
}

/** True when a file must be (re)downloaded given its manifest entry + presence. */
export function needsDownload(
  file: { updated_at: string },
  entry: ManifestEntry | undefined,
  localExists: boolean,
): boolean {
  if (!localExists || !entry) return true;
  return entry.updated_at !== file.updated_at;
}

const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const READ_ONLY = 0o444;
const OWNER_WRITE = 0o644;

export interface SyncSummary {
  courses: number;
  downloaded: number;
  skipped: number;
  failed: number;
  bytes: number;
  errors: string[];
}

export interface SyncOpts {
  canvasDir: string;
  coursesFilter?: string;
  maxBytes?: number;
}

type Manifest = Record<string, ManifestEntry>;

function loadManifest(file: string): Manifest {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as Manifest;
  } catch {
    return {};
  }
}

async function downloadFile(cfg: CanvasConfig, url: string): Promise<Buffer> {
  const doFetch = cfg.fetchImpl ?? fetch;
  const res = await doFetch(url, { headers: { Authorization: `Bearer ${cfg.token}` } });
  if (!res.ok) throw new Error(`download ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Write `buf` to `dest` as a read-only file, clearing a prior read-only bit. */
function writeReadOnly(dest: string, buf: Buffer): void {
  if (fs.existsSync(dest)) fs.chmodSync(dest, OWNER_WRITE);
  fs.writeFileSync(dest, buf);
  fs.chmodSync(dest, READ_ONLY);
}

/**
 * Mirror active-course files into `canvasDir/<course>/<file>`, read-only and
 * idempotent (a `.manifest.json` skips unchanged files). Per-file and per-course
 * failures are counted, not fatal.
 */
export async function syncCanvas(cfg: CanvasConfig, opts: SyncOpts): Promise<SyncSummary> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const summary: SyncSummary = { courses: 0, downloaded: 0, skipped: 0, failed: 0, bytes: 0, errors: [] };

  fs.mkdirSync(opts.canvasDir, { recursive: true });
  const manifestPath = path.join(opts.canvasDir, '.manifest.json');
  const manifest = loadManifest(manifestPath);

  const courses = (await listActiveCourses(cfg)).filter((c) =>
    courseAllowed(c, opts.coursesFilter ?? ''),
  );
  summary.courses = courses.length;

  for (const course of courses) {
    const courseDir = path.join(opts.canvasDir, courseDirName(course));
    try {
      fs.mkdirSync(courseDir, { recursive: true });
      const files = await listCourseFiles(cfg, course.id);
      for (const file of files) {
        if (file.size > maxBytes) {
          summary.skipped++;
          logger.warn({ file: file.display_name, size: file.size }, 'canvas: file over maxBytes; skipping');
          continue;
        }
        const dest = path.join(courseDir, sanitizeName(file.display_name));
        if (!needsDownload(file, manifest[file.id], fs.existsSync(dest))) {
          summary.skipped++;
          continue;
        }
        try {
          const buf = await downloadFile(cfg, file.url);
          writeReadOnly(dest, buf);
          manifest[file.id] = { updated_at: file.updated_at, path: path.relative(opts.canvasDir, dest) };
          summary.downloaded++;
          summary.bytes += buf.length;
        } catch (err) {
          summary.failed++;
          summary.errors.push(`${courseDirName(course)}/${file.display_name}: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      summary.failed++;
      summary.errors.push(`${courseDirName(course)}: ${(err as Error).message}`);
    }
  }

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return summary;
}
