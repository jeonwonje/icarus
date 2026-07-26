import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import type { Context } from 'grammy';
import { cfg } from '../config.js';
import { log } from '../log.js';

const sanitize = (name: string) => name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120);

function pickName(ctx: Context): string {
  const m = ctx.message!;
  const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '');
  if (m.document?.file_name) return sanitize(m.document.file_name);
  if (m.photo) return `photo_${stamp}.jpg`;
  if (m.voice) return `voice_${stamp}.ogg`;
  if (m.audio) return sanitize(m.audio.file_name ?? `audio_${stamp}.mp3`);
  if (m.video) return sanitize(m.video.file_name ?? `video_${stamp}.mp4`);
  if (m.video_note) return `videonote_${stamp}.mp4`;
  return `file_${stamp}.bin`;
}

export interface SavedFile {
  savedPath: string;
  name: string;
}

/**
 * Download the message's media into 0_Inbox\ (flat, date-prefixed). Returns null if the
 * message has no media. Throws with a readable message on Bot API limits (20 MB download cap).
 */
export async function saveIncomingFile(ctx: Context): Promise<SavedFile | null> {
  const m = ctx.message;
  if (!m || !(m.document || m.photo || m.voice || m.audio || m.video || m.video_note)) return null;

  const file = await ctx.getFile(); // throws "file is too big" beyond 20 MB
  if (!file.file_path) throw new Error('Telegram returned no file_path');

  const day = new Date().toISOString().slice(0, 10);
  const dir = cfg.inboxDir;
  mkdirSync(dir, { recursive: true });

  let name = `${day}_${pickName(ctx)}`;
  let dest = path.join(dir, name);
  for (let i = 1; existsSync(dest); i++) {
    const ext = path.extname(name);
    dest = path.join(dir, `${path.basename(name, ext)}-${i}${ext}`);
  }
  name = path.basename(dest);

  const url = `https://api.telegram.org/file/bot${cfg.botToken}/${file.file_path}`;
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  log.info({ dest }, 'inbox file saved');
  return { savedPath: dest, name };
}
