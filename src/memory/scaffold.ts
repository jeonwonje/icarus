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

export function threadsRoot(): string {
  return path.join(DATA_DIR, 'threads');
}

/**
 * Idempotently create the top-level `data/` skeleton: `threads/` and `skills/`.
 * `data/CLAUDE.md` ships in git, so we don't generate it. Per-thread folders
 * are created on demand by `ensureThreadLayout()`.
 */
export function ensureDataLayout(): boolean {
  let created = false;
  for (const dir of [threadsRoot(), skillsDir()]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      created = true;
    }
  }
  if (created) logger.info({ dir: DATA_DIR }, 'data layout ready');
  return created;
}
