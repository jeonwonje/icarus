import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { CANVAS_API_TOKEN, CANVAS_BASE_URL } from '../core/config.js';
import {
  canvasCourseAllowed,
  loadSourcesConfig,
  type SourcesConfig,
} from '../config/sources.js';
import { rawCanvasDir } from '../memory/scaffold.js';
import { sanitizeFileName } from '../core/slug.js';
import { logger } from '../core/logger.js';

export interface CanvasCourse {
  id: string;
  name: string;
}

/** Pure selection: apply the course allowlist. Exported for tests. */
export function selectCourses(courses: CanvasCourse[], cfg: SourcesConfig): CanvasCourse[] {
  return courses.filter((c) => canvasCourseAllowed(cfg, c.id));
}

interface CanvasFileEntry {
  id: number;
  display_name: string;
  url: string;
}

async function api<T>(endpoint: string): Promise<T> {
  const res = await fetch(`${CANVAS_BASE_URL}/api/v1${endpoint}`, {
    headers: { Authorization: `Bearer ${CANVAS_API_TOKEN}` },
  });
  if (!res.ok) throw new Error(`Canvas ${endpoint} → ${res.status}`);
  return (await res.json()) as T;
}

async function listCourses(): Promise<CanvasCourse[]> {
  const raw = await api<{ id: number; name: string }[]>(
    '/courses?enrollment_state=active&per_page=100',
  );
  return raw.map((c) => ({ id: String(c.id), name: c.name ?? `course-${c.id}` }));
}

async function listFiles(courseId: string): Promise<CanvasFileEntry[]> {
  return api<CanvasFileEntry[]>(`/courses/${courseId}/files?per_page=100`);
}

async function downloadFile(entry: CanvasFileEntry, destDir: string): Promise<void> {
  const res = await fetch(entry.url);
  if (!res.ok) throw new Error(`download ${entry.id} → ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(path.join(destDir, sanitizeFileName(entry.display_name)), buf);
}

export async function main(): Promise<void> {
  if (!CANVAS_BASE_URL || !CANVAS_API_TOKEN) {
    throw new Error('CANVAS_BASE_URL and CANVAS_API_TOKEN must be set in .env');
  }
  const cfg = loadSourcesConfig();
  const courses = selectCourses(await listCourses(), cfg);
  let count = 0;
  for (const course of courses) {
    const destDir = path.join(rawCanvasDir(), sanitizeFileName(`${course.id}-${course.name}`));
    let files: CanvasFileEntry[];
    try {
      files = await listFiles(course.id);
    } catch (err) {
      logger.warn({ course: course.id, err: String(err) }, 'list files failed, skipping course');
      continue;
    }
    for (const f of files) {
      try {
        await downloadFile(f, destDir);
        count++;
      } catch (err) {
        logger.warn({ file: f.id, err: String(err) }, 'file download failed');
      }
    }
  }
  logger.info({ courses: courses.length, files: count }, 'canvas ingest complete');
  process.stdout.write(`Canvas ingest complete: ${courses.length} courses, ${count} files.\n`);
}

// Run when invoked directly (tsx src/ingest/canvas.ts or node dist/ingest/canvas.js).
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    logger.error({ err }, 'canvas ingest failed');
    process.stderr.write(`Canvas ingest failed: ${err instanceof Error ? err.message : err}\n`);
    process.exit(1);
  });
}
