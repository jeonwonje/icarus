export interface Course {
  id: number;
  course_code?: string;
  name?: string;
}

export interface ManifestEntry {
  updated_at: string;
  path: string;
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
