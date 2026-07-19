import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { cfg } from './config.js';
import { log } from './log.js';
import { sendOwnerDocument } from './telegram/send.js';

const sanitizeJid = (jid: string) => jid.replace(/[^a-z0-9-]/gi, '-');

export function outboxDirFor(jid: string): string {
  const dir = path.join(cfg.outboxDir, sanitizeJid(jid));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Send every file in the turn's outbox to the owner, then archive to _delivered/ (keep 20). */
export async function drainOutbox(jid: string): Promise<number> {
  const dir = outboxDirFor(jid);
  const delivered = path.join(dir, '_delivered');
  mkdirSync(delivered, { recursive: true });

  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.endsWith('.caption'))
    .map((e) => e.name);

  for (const name of entries) {
    const filePath = path.join(dir, name);
    const captionPath = path.join(dir, `${name}.caption`);
    let caption: string | undefined;
    if (existsSync(captionPath)) {
      try {
        caption = readFileSync(captionPath, 'utf8').trim();
      } catch {
        /* caption is best-effort */
      }
    }
    await sendOwnerDocument(filePath, caption);
    try {
      renameSync(filePath, path.join(delivered, name));
      if (existsSync(captionPath)) rmSync(captionPath);
    } catch (e) {
      log.warn({ err: String(e), filePath }, 'outbox archive failed');
    }
  }

  // Bound the archive: newest 20 stay.
  const archived = readdirSync(delivered)
    .map((n) => ({ n, t: statSync(path.join(delivered, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const { n } of archived.slice(20)) {
    rmSync(path.join(delivered, n), { force: true });
  }
  return entries.length;
}
