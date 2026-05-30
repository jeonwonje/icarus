#!/usr/bin/env tsx
/**
 * Sync NUS Canvas course files into read-only data/raw/canvas/. Runnable
 * manually or from a systemd timer. Shares config with the bot; the token
 * lives in .env (gitignored).
 */
import path from 'path';

import { CANVAS_API_TOKEN, CANVAS_BASE_URL, CANVAS_COURSES } from '../src/config.js';
import { syncCanvas } from '../src/canvas.js';
import { logger } from '../src/logger.js';
import { ensureDataLayout, rawDir } from '../src/memory/scaffold.js';

async function main(): Promise<void> {
  if (!CANVAS_API_TOKEN) {
    console.error('CANVAS_API_TOKEN not set in .env — nothing to sync.');
    process.exit(1);
  }
  ensureDataLayout();
  const canvasDir = path.join(rawDir(), 'canvas');
  const started = Date.now();
  const s = await syncCanvas(
    { baseUrl: CANVAS_BASE_URL, token: CANVAS_API_TOKEN },
    { canvasDir, coursesFilter: CANVAS_COURSES },
  );
  const sec = Math.round((Date.now() - started) / 1000);
  logger.info({ ...s, sec }, 'canvas sync complete');
  console.log(
    `Canvas: ${s.downloaded} new files, ${s.announcements} new announcements, ${s.skipped} unchanged, ${s.failed} failed across ${s.courses} courses · ${(s.bytes / 1e6).toFixed(1)} MB in ${sec}s`,
  );
  for (const e of s.errors.slice(0, 10)) console.error(`  ✗ ${e}`);
  if (s.failed > 0 && s.downloaded === 0) process.exit(1);
}

main().catch((err) => {
  logger.fatal({ err }, 'canvas-sync fatal');
  process.exit(1);
});
