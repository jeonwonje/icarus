import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parseEml, decodeWord, htmlToText } from './mime.mjs';

const execFileP = promisify(execFile);

// ── path-safe naming (copied from canvas) ──────────────────────────────────
export function sanitizeName(name) {
  const s = (name ?? '').replace(/[/\\]/g, '_').replace(/\p{Cc}/gu, '').trim();
  if (s === '' || s === '.' || s === '..') return 'file';
  return s;
}

export function slug(s) {
  const out = sanitizeName(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return out || 'untitled';
}
