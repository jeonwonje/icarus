import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';

export function dataDir(): string {
  return DATA_DIR;
}

export function skillsDir(): string {
  return path.join(DATA_DIR, 'skills');
}

export function wikiDir(): string {
  return path.join(DATA_DIR, 'wiki');
}

export function outboxDir(): string {
  return path.join(DATA_DIR, 'outbox');
}

export function indexFile(): string {
  return path.join(DATA_DIR, 'index.md');
}

export function logFile(): string {
  return path.join(DATA_DIR, 'log.md');
}

/**
 * Idempotently create the data/ skeleton: wiki/, outbox/, skills/, and seed
 * index.md + log.md if missing. data/CLAUDE.md ships in git.
 */
export function ensureDataLayout(): boolean {
  let created = false;
  for (const dir of [wikiDir(), outboxDir(), skillsDir()]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      created = true;
    }
  }
  if (!fs.existsSync(indexFile())) {
    fs.writeFileSync(
      indexFile(),
      '# Wiki index\n\nNo pages yet. As you build up notes in `wiki/`, list them here with a one-line summary.\n',
    );
    created = true;
  }
  if (!fs.existsSync(logFile())) {
    fs.writeFileSync(
      logFile(),
      `# Activity log\n\n${new Date().toISOString()} — data layout created.\n`,
    );
    created = true;
  }
  if (created) logger.info({ dir: DATA_DIR }, 'data layout ready');
  return created;
}
