import fs from 'fs';
import path from 'path';

import { dataDir } from './scaffold.js';

const JID_RE = /^tg:(-?\d+):(\d+)$/;

/**
 * Map a thread JID (`tg:<chatId>:<threadId>` or a CLI synthetic like
 * `cli:weekly-prune`) to its on-disk folder under `data/threads/`.
 *
 * Telegram threads use the integer `thread_id` as the folder name. CLI JIDs
 * fall back to a sanitized representation prefixed with `_` so they sort
 * apart from numeric thread folders.
 */
export function threadDir(jid: string): string {
  const m = JID_RE.exec(jid);
  const name = m ? m[2] : `_${jid.replace(/[^a-z0-9_-]/gi, '_')}`;
  return path.join(dataDir(), 'threads', name);
}

export function threadWikiDir(jid: string): string {
  return path.join(threadDir(jid), 'wiki');
}

export function threadOutboxDir(jid: string): string {
  return path.join(threadDir(jid), 'outbox');
}

export function threadIndexFile(jid: string): string {
  return path.join(threadDir(jid), 'index.md');
}

export function threadLogFile(jid: string): string {
  return path.join(threadDir(jid), 'log.md');
}

/**
 * Idempotently scaffold the per-thread folder: `wiki/`, `index.md`, `log.md`.
 * The outbox dir is created on demand by the agent. Returns true if anything
 * was created on this call.
 */
export function ensureThreadLayout(jid: string): boolean {
  fs.mkdirSync(threadWikiDir(jid), { recursive: true });
  let created = false;
  const indexFile = threadIndexFile(jid);
  if (!fs.existsSync(indexFile)) {
    fs.writeFileSync(
      indexFile,
      '# Wiki index\n\nNo pages yet. As you build up notes in `wiki/`, list them here with a one-line summary.\n',
    );
    created = true;
  }
  const logFile = threadLogFile(jid);
  if (!fs.existsSync(logFile)) {
    fs.writeFileSync(
      logFile,
      `# Activity log\n\n${new Date().toISOString()} — thread folder created.\n`,
    );
    created = true;
  }
  return created;
}
