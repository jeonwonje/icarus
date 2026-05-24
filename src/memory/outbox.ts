import fs from 'fs';
import path from 'path';

import { outboxDir } from './scaffold.js';

export interface OutboxFile {
  absPath: string;
  filename: string;
  caption?: string;
  fileType: 'image' | 'document';
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

function classify(ext: string): 'image' | 'document' {
  return IMAGE_EXTS.has(ext.toLowerCase()) ? 'image' : 'document';
}

export function listOutbox(): OutboxFile[] {
  const dir = outboxDir();
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: OutboxFile[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (e.name.endsWith('.caption')) continue;
    const abs = path.join(dir, e.name);
    const captionPath = abs + '.caption';
    let caption: string | undefined;
    if (fs.existsSync(captionPath)) {
      const raw = fs.readFileSync(captionPath, 'utf-8').trim();
      if (raw) caption = raw.slice(0, 1024);
    }
    files.push({
      absPath: abs,
      filename: e.name,
      caption,
      fileType: classify(path.extname(e.name)),
    });
  }
  return files;
}

export function removeOutboxFile(file: OutboxFile): void {
  try {
    fs.unlinkSync(file.absPath);
  } catch {
    /* best-effort */
  }
  const captionPath = file.absPath + '.caption';
  if (fs.existsSync(captionPath)) {
    try {
      fs.unlinkSync(captionPath);
    } catch {
      /* best-effort */
    }
  }
}
