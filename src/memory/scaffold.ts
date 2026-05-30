import fs from 'fs';
import path from 'path';

import { DATA_DIR, RAW_DIR, SANDBOX_MOUNTS } from '../config.js';
import { logger } from '../logger.js';
import { parseSandboxMounts, type SandboxMount } from '../sandbox.js';

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

export function rawDir(): string {
  return path.join(DATA_DIR, 'raw');
}

export function indexFile(): string {
  return path.join(DATA_DIR, 'index.md');
}

export function logFile(): string {
  return path.join(DATA_DIR, 'log.md');
}

/**
 * Ensure data/raw points at the source tree. Normal case: symlink data/raw to
 * RAW_DIR (a Windows-Desktop folder) so files are browsable from Windows while
 * the agent still cites them as raw/<file>. If RAW_DIR's parent doesn't exist
 * (e.g. running off-Windows with no /mnt/c), fall back to a real local
 * data/raw directory so the bot still runs. No-op if data/raw already exists.
 */
function ensureRawLink(): boolean {
  const link = rawDir();
  let existing: fs.Stats | null = null;
  try {
    existing = fs.lstatSync(link);
  } catch {
    existing = null;
  }
  if (existing) return false; // real dir or symlink already present — leave it

  const parent = path.dirname(RAW_DIR);
  if (fs.existsSync(parent)) {
    fs.mkdirSync(RAW_DIR, { recursive: true });
    fs.symlinkSync(RAW_DIR, link);
    logger.info({ link, target: RAW_DIR }, 'raw/ symlinked to source tree');
  } else {
    fs.mkdirSync(link, { recursive: true });
    logger.warn({ target: RAW_DIR, parent }, 'RAW_DIR parent missing; using local data/raw');
  }
  return true;
}

/**
 * For each operator-specified mount, ensure raw/<name> symlinks to its target.
 * Refreshes a stale symlink so editing SANDBOX_MOUNTS re-points it; never
 * overwrites a real file/dir; skips a missing target (the sandbox bind is
 * --bind-try, so it tolerates absence too).
 */
export function ensureSandboxMounts(mounts: SandboxMount[]): boolean {
  let changed = false;
  for (const { name, target } of mounts) {
    if (!fs.existsSync(target)) {
      logger.warn({ name, target }, 'SANDBOX_MOUNTS target missing; skipping');
      continue;
    }
    const link = path.join(rawDir(), name);
    let existing: fs.Stats | null = null;
    try {
      existing = fs.lstatSync(link);
    } catch {
      existing = null;
    }
    if (!existing) {
      fs.symlinkSync(target, link);
      logger.info({ link, target }, 'sandbox mount symlinked');
      changed = true;
    } else if (existing.isSymbolicLink()) {
      if (fs.readlinkSync(link) !== target) {
        fs.unlinkSync(link);
        fs.symlinkSync(target, link);
        logger.info({ link, target }, 'sandbox mount symlink repointed');
        changed = true;
      }
    } else {
      logger.warn({ link }, 'raw/<name> is a real file/dir; refusing to overwrite');
    }
  }
  return changed;
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
  if (ensureRawLink()) created = true;
  if (ensureSandboxMounts(parseSandboxMounts(SANDBOX_MOUNTS))) created = true;
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
