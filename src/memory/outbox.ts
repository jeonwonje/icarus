import fs from 'fs';
import path from 'path';
import { channelOutboxDir } from './scaffold.js';

export interface OutboxFile {
  absPath: string;
  filename: string;
  kind: 'document' | 'photo';
  caption?: string;
}

const PHOTO_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

export function listOutbox(channel: string): OutboxFile[] {
  const dir = channelOutboxDir(channel);
  if (!fs.existsSync(dir)) return [];
  const out: OutboxFile[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith('.caption')) continue;
    const absPath = path.join(dir, name);
    if (!fs.statSync(absPath).isFile()) continue;
    const captionPath = `${absPath}.caption`;
    const caption = fs.existsSync(captionPath)
      ? fs.readFileSync(captionPath, 'utf-8').trim()
      : undefined;
    const kind = PHOTO_EXT.has(path.extname(name).toLowerCase()) ? 'photo' : 'document';
    out.push({ absPath, filename: name, kind, caption });
  }
  return out;
}

export function removeOutboxFile(f: { absPath: string }): void {
  try {
    fs.rmSync(f.absPath, { force: true });
    fs.rmSync(`${f.absPath}.caption`, { force: true });
  } catch {
    /* ignore */
  }
}
