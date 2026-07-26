import { createHash } from 'node:crypto';
import {
  copyFileSync,
  createReadStream,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { cfg } from './config.js';
import type { RawShelfStore } from './rawShelfStore.js';

export interface FileToRawInput {
  project: string;
  sourcePath: string;
  displayName: string;
  store: RawShelfStore;
  now?: Date;
  desktopDir?: string;
  tz?: string;
}

export interface FileToRawResult {
  path: string;
  reused: boolean;
  hash: string;
}

const hashFile = async (filePath: string): Promise<string> => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
};

const hashBuffer = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

const calendarDate = (now: Date, tz: string): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);

/** Windows-safe basename, max 120 chars, extension preserved when possible. */
export function sanitizeDisplayName(displayName: string): string {
  const base = path.basename(displayName).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'file';
  if (base.length <= 120) return base;
  const ext = path.extname(base);
  const stem = path.basename(base, ext).slice(0, Math.max(1, 120 - ext.length));
  return `${stem}${ext}`;
}

const sameVolume = (a: string, b: string): boolean => {
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  if (process.platform === 'win32') {
    return ra.slice(0, 1).toLowerCase() === rb.slice(0, 1).toLowerCase();
  }
  try {
    return statSync(ra).dev === statSync(path.dirname(rb)).dev;
  } catch {
    return false;
  }
};

const placeBytes = (sourcePath: string, dest: string): void => {
  mkdirSync(path.dirname(dest), { recursive: true });
  if (sameVolume(sourcePath, dest)) {
    try {
      linkSync(sourcePath, dest);
      return;
    } catch {
      /* fall through to copy */
    }
  }
  copyFileSync(sourcePath, dest);
};

function chooseRelPath(rawDir: string, datePrefix: string, sanitized: string, hash: string): string {
  const ext = path.extname(sanitized);
  const stem = path.basename(sanitized, ext);
  let candidate = `${datePrefix}_${sanitized}`;
  for (let i = 2; ; i++) {
    const full = path.join(rawDir, candidate);
    if (!existsSync(full)) return candidate;
    if (hashBuffer(readFileSync(full)) === hash) return candidate;
    candidate = `${datePrefix}_${stem}-${i}${ext}`;
  }
}

/** Shelves source bytes under Desktop/<project>/raw/ with sha256 dedup. */
export async function fileToRaw(input: FileToRawInput): Promise<FileToRawResult> {
  const project = input.project.trim();
  if (!project) throw new Error('project slug is required');

  const desktopDir = input.desktopDir ?? cfg.desktopDir;
  const tz = input.tz ?? cfg.tz;
  const projectDir = path.join(desktopDir, project);
  if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) {
    throw new Error(`Desktop project folder missing: ${projectDir}`);
  }
  if (!existsSync(input.sourcePath)) {
    throw new Error(`source file missing: ${input.sourcePath}`);
  }

  const rawDir = path.join(projectDir, 'raw');
  mkdirSync(rawDir, { recursive: true });

  const hash = await hashFile(input.sourcePath);
  const bytes = statSync(input.sourcePath).size;
  const existing = input.store.get(project, hash);
  if (existing) {
    const abs = path.join(rawDir, existing.relPath);
    if (existsSync(abs)) {
      return { path: abs, reused: true, hash };
    }
    input.store.delete(project, hash);
  }

  const sanitized = sanitizeDisplayName(input.displayName);
  const datePrefix = calendarDate(input.now ?? new Date(), tz);
  const relPath = chooseRelPath(rawDir, datePrefix, sanitized, hash);
  const dest = path.join(rawDir, relPath);
  if (!existsSync(dest)) {
    placeBytes(input.sourcePath, dest);
  }

  const createdAt = (input.now ?? new Date()).toISOString();
  input.store.upsert({
    project,
    sha256: hash,
    relPath,
    bytes,
    createdAt,
  });
  return { path: dest, reused: false, hash };
}

/** Resolve archive blob bytes on disk from sha256. */
export function blobPathForHash(hash: string, archiveDir = cfg.telegramArchiveDir): string {
  return path.join(archiveDir, 'blobs', 'sha256', hash.slice(0, 2), hash);
}
