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
