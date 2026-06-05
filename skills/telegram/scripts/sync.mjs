// skills/telegram/scripts/sync.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const READ_ONLY = 0o444;

const DEFAULT_ARCHIVE_DIR = '/mnt/c/Users/jeonw/Desktop/telegram-chats';

/** Read the three required secrets from the environment. */
export function resolveEnv(env = process.env) {
  const apiId = env.TELEGRAM_API_ID;
  const apiHash = env.TELEGRAM_API_HASH;
  const session = env.TELEGRAM_SESSION;
  if (!apiId || !apiHash || !session) {
    throw new Error(
      'Missing TELEGRAM_API_ID / TELEGRAM_API_HASH / TELEGRAM_SESSION. ' +
        'Run `node skills/telegram/scripts/login.mjs` and paste the printed values into ~/.bashrc.',
    );
  }
  return { apiId: Number(apiId), apiHash, session };
}

/** Derive every archive path from TELEGRAM_ARCHIVE_DIR (default: Desktop, local-only). */
export function resolvePaths(env = process.env) {
  const archiveDir = env.TELEGRAM_ARCHIVE_DIR || DEFAULT_ARCHIVE_DIR;
  return {
    archiveDir,
    archiveRoot: path.join(archiveDir, 'archive'),
    manifestPath: path.join(archiveDir, '.telegram-manifest.json'),
    deltaPath: path.join(archiveDir, 'delta', 'latest.json'),
  };
}

/** One safe, lowercase path segment: separators/space → '-', control chars stripped. */
export function sanitizeSegment(name) {
  const s = String(name ?? '')
    .replace(/\p{Cc}/gu, '')
    .trim()
    .toLowerCase()
    .replace(/[/\\\s]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return s;
}

/** Stable per-dialog slug: sanitized title + numeric id (always unique + readable). */
export function slugify(title, id) {
  const base = sanitizeSegment(title) || 'chat';
  return `${base}-${id}`;
}

/** Bucket a GramJS dialog: user → DM, anything else → group/channel. */
export function dialogType(dialog) {
  if (dialog.isUser) return 'user';
  if (dialog.isChannel) return 'channel';
  return 'group';
}
