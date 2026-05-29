import fs from 'fs';
import https from 'https';
import path from 'path';

import { Bot, InputFile, type Api, type Context } from 'grammy';
import { run, sequentialize, type RunnerHandle } from '@grammyjs/runner';

import {
  OPERATOR_USER_ID,
  TELEGRAM_BOT_DOWNLOAD_LIMIT_BYTES,
  TELEGRAM_BOT_TOKEN,
} from './config.js';
import { insertMessage } from './db.js';
import { logger } from './logger.js';
import { rawDir } from './memory/scaffold.js';
import { sanitizeFileName } from './slug.js';

export interface InboundMessage {
  senderId: string;
  senderName: string | null;
  chatId: number;
  content: string;
  isCommand: boolean;
  command?: string;
  commandArgs?: string;
  telegramMsgId: string;
}

export interface DownloadedFile {
  localPath: string;
  originalName: string;
  kind: 'document' | 'photo' | 'audio' | 'voice' | 'video';
  sizeBytes: number;
}

export interface TelegramBotHandlers {
  /** Called on every operator DM. Should not throw — runner handles errors. */
  onMessage: (msg: InboundMessage) => Promise<void>;
}

// --- Command parsing --------------------------------------------------

function parseCommand(text: string | undefined): { command: string; args: string } | null {
  if (!text || !text.startsWith('/')) return null;
  const m = text.match(/^\/([A-Za-z][\w-]*)(?:@\w+)?\s*(.*)$/s);
  if (!m) return null;
  return { command: m[1].toLowerCase(), args: m[2].trim() };
}

// --- Attachment helpers -----------------------------------------------

/**
 * Loose shape of the fields we read off a Telegram message. grammY's own type
 * is far larger; we only touch these.
 */
interface RawMessage {
  message_id?: number;
  text?: string;
  caption?: string;
  document?: { file_id?: string; file_name?: string; file_size?: number };
  photo?: { file_id?: string; file_size?: number }[];
  audio?: { file_id?: string; file_name?: string; mime_type?: string; file_size?: number };
  voice?: { file_id?: string; file_size?: number };
  video?: { file_id?: string; file_name?: string; file_size?: number };
}

/**
 * Return the first attachment whose advertised size exceeds Telegram's 20 MB
 * bot-download cap, or null. Photos are excluded — Telegram rescales them.
 */
export function detectOversizedAttachment(
  m: RawMessage,
): { name: string; sizeBytes: number } | null {
  const candidates: { name: string; size?: number }[] = [];
  if (m.document) candidates.push({ name: m.document.file_name || `doc_${m.message_id}`, size: m.document.file_size });
  if (m.video) candidates.push({ name: m.video.file_name || `video_${m.message_id}.mp4`, size: m.video.file_size });
  if (m.audio) candidates.push({ name: m.audio.file_name || `audio_${m.message_id}`, size: m.audio.file_size });
  if (m.voice) candidates.push({ name: `voice_${m.message_id}.ogg`, size: m.voice.file_size });
  for (const c of candidates) {
    if (typeof c.size === 'number' && c.size > TELEGRAM_BOT_DOWNLOAD_LIMIT_BYTES) {
      return { name: c.name, sizeBytes: c.size };
    }
  }
  return null;
}

/** Build the agent prompt text from the caption plus one note per saved file. */
export function buildContentWithFileNotes(text: string, files: DownloadedFile[]): string {
  if (files.length === 0) return text;
  const lines = files.map(
    (f) => `[${f.kind}: ${f.originalName}] saved to raw/${path.basename(f.localPath)}`,
  );
  if (text) lines.push(text);
  return lines.join('\n');
}

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(1)} MB`;
}

async function downloadTelegramFile(
  api: Api,
  token: string,
  fileId: string,
  fileName: string,
): Promise<string | null> {
  try {
    const file = await api.getFile(fileId);
    if (!file.file_path) {
      logger.warn({ fileId }, 'getFile returned no file_path');
      return null;
    }
    const dir = rawDir();
    fs.mkdirSync(dir, { recursive: true });
    const safe = sanitizeFileName(fileName);
    let localPath = path.join(dir, safe);
    if (fs.existsSync(localPath)) {
      localPath = path.join(dir, `${Date.now()}_${safe}`);
    }
    const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
    await new Promise<void>((resolve, reject) => {
      const out = fs.createWriteStream(localPath);
      https
        .get(url, (res) => {
          if (res.statusCode !== 200) {
            out.close();
            try { fs.unlinkSync(localPath); } catch { /* ignore */ }
            reject(new Error(`HTTP ${res.statusCode} downloading file`));
            return;
          }
          res.pipe(out);
          out.on('finish', () => { out.close(); resolve(); });
          out.on('error', (err) => {
            // Destroy the stream and remove the partial file so a failed
            // download never leaves a truncated source behind.
            out.destroy();
            try { fs.unlinkSync(localPath); } catch { /* ignore */ }
            reject(err);
          });
        })
        .on('error', (err) => {
          out.destroy();
          try { fs.unlinkSync(localPath); } catch { /* ignore */ }
          reject(err);
        });
    });
    return localPath;
  } catch (err) {
    logger.error({ fileId, fileName, err }, 'downloadTelegramFile failed');
    return null;
  }
}

async function extractFiles(ctx: Context): Promise<DownloadedFile[]> {
  const msg = ctx.message;
  if (!msg) return [];
  const out: DownloadedFile[] = [];
  const push = async (
    fileId: string,
    name: string,
    kind: DownloadedFile['kind'],
  ): Promise<void> => {
    const local = await downloadTelegramFile(ctx.api, TELEGRAM_BOT_TOKEN, fileId, name);
    if (local) out.push({ localPath: local, originalName: name, kind, sizeBytes: fs.statSync(local).size });
  };
  if (msg.document) {
    await push(msg.document.file_id, msg.document.file_name || `doc_${msg.document.file_id}`, 'document');
  }
  if (msg.photo && msg.photo.length > 0) {
    const best = msg.photo[msg.photo.length - 1]; // largest size
    await push(best.file_id, `photo_${msg.message_id}.jpg`, 'photo');
  }
  if (msg.audio) {
    const ext = msg.audio.mime_type?.includes('mp3') ? 'mp3' : 'audio';
    await push(msg.audio.file_id, msg.audio.file_name || `audio_${msg.audio.file_id}.${ext}`, 'audio');
  }
  if (msg.voice) {
    await push(msg.voice.file_id, `voice_${msg.message_id}.ogg`, 'voice');
  }
  if (msg.video) {
    await push(msg.video.file_id, msg.video.file_name || `video_${msg.message_id}.mp4`, 'video');
  }
  return out;
}

// --- Outbound helpers -------------------------------------------------

const TG_MSG_MAX = 4000;

export function startTyping(api: Api, chatId: number | string): () => void {
  let stopped = false;
  const tick = (): void => {
    if (stopped) return;
    api.sendChatAction(chatId, 'typing').catch(() => {
      /* indicator is best-effort */
    });
  };
  tick();
  const timer = setInterval(tick, 4000);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export async function sendText(
  api: Api,
  chatId: number | string,
  text: string,
): Promise<{ messageId: number } | null> {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > TG_MSG_MAX) {
    const cut = remaining.lastIndexOf('\n', TG_MSG_MAX);
    const idx = cut > 0 ? cut : TG_MSG_MAX;
    chunks.push(remaining.slice(0, idx));
    remaining = remaining.slice(idx);
  }
  if (remaining) chunks.push(remaining);
  let lastId: number | null = null;
  for (const chunk of chunks) {
    const sent = await api.sendMessage(chatId, chunk);
    lastId = sent.message_id;
  }
  return lastId !== null ? { messageId: lastId } : null;
}

export async function sendFile(
  api: Api,
  chatId: number | string,
  absPath: string,
  kind: 'image' | 'document',
  caption?: string,
): Promise<void> {
  const input = new InputFile(absPath);
  const opts: { caption?: string } = {};
  if (caption) opts.caption = caption;
  if (kind === 'image') {
    await api.sendPhoto(chatId, input, opts);
  } else {
    await api.sendDocument(chatId, input, opts);
  }
}

// --- Operator gating --------------------------------------------------

/**
 * Bootstrap mode (`OPERATOR_USER_ID` empty): any DM gets a reply containing
 * the sender's user id, then no further processing. Once `OPERATOR_USER_ID`
 * is set, only that user id can drive the agent in a private chat. Group
 * chats are ignored entirely.
 */
function isAuthorized(ctx: Context): boolean {
  if (ctx.chat?.type !== 'private') return false;
  const from = ctx.from?.id;
  if (from === undefined) return false;
  return String(from) === OPERATOR_USER_ID;
}

// --- Main bot entrypoint ----------------------------------------------

export function createBot(handlers: TelegramBotHandlers): Bot {
  if (!TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN not set');
  const bot = new Bot(TELEGRAM_BOT_TOKEN);

  bot.api
    .setMyCommands([
      { command: 'whoami', description: 'Show your user id and operator status' },
      { command: 'ping', description: 'Health check' },
      { command: 'help', description: 'Show commands' },
    ])
    .catch((err) => logger.warn({ err }, 'setMyCommands failed'));

  // Serialize updates per chat (in practice always one operator chat).
  bot.use(
    sequentialize((ctx) => {
      const chat = ctx.chat?.id;
      return chat === undefined ? undefined : String(chat);
    }),
  );

  let bootstrapWarned = false;

  bot.on('message', async (ctx) => {
    try {
      if (ctx.chat?.type !== 'private') return;
      const chatId = ctx.chat.id;
      const fromId = ctx.from?.id;
      if (fromId === undefined) return;
      const senderId = String(fromId);
      const senderName = ctx.from?.username || ctx.from?.first_name || null;
      const text = ctx.message?.text;
      const parsed = parseCommand(text);

      // Bootstrap mode: no operator configured yet.
      if (!OPERATOR_USER_ID) {
        if (!bootstrapWarned) {
          logger.warn({}, 'OPERATOR_USER_ID not set — bootstrap mode. Set it once you know your user id.');
          bootstrapWarned = true;
        }
        await ctx.api.sendMessage(
          chatId,
          `your_user_id: ${senderId}\n\nPaste this into OPERATOR_USER_ID in .env and restart.`,
        );
        return;
      }

      // Authorized operator gate.
      if (!isAuthorized(ctx)) {
        logger.debug({ senderId }, 'unauthorized DM ignored');
        return;
      }

      const oversized = detectOversizedAttachment((ctx.message ?? {}) as unknown as RawMessage);
      if (oversized) {
        await ctx.api.sendMessage(
          chatId,
          `[oversized: ${oversized.name} (${formatBytes(oversized.sizeBytes)}) not downloaded — ` +
            `exceeds Telegram's 20 MB bot-download cap]`,
        );
      }
      const files = oversized ? [] : await extractFiles(ctx);
      const inboundText = ctx.message?.text ?? ctx.message?.caption ?? '';
      const content = buildContentWithFileNotes(inboundText, files);
      insertMessage({
        telegramMsgId: String(ctx.message?.message_id ?? Date.now()),
        senderId,
        senderName,
        content,
        timestamp: new Date().toISOString(),
      });

      await handlers.onMessage({
        senderId,
        senderName,
        chatId,
        content,
        isCommand: !!parsed,
        command: parsed?.command,
        commandArgs: parsed?.args,
        telegramMsgId: String(ctx.message?.message_id ?? ''),
      });
    } catch (err) {
      logger.error({ err }, 'Unhandled error in message handler');
      try {
        const chatId = ctx.chat?.id;
        if (typeof chatId === 'number') {
          await sendText(ctx.api, chatId, `[error: ${(err as Error).message ?? err}]`);
        }
      } catch {
        /* best effort */
      }
    }
  });

  bot.catch((err) => {
    logger.error({ err: err.error }, 'Bot runtime error');
  });

  return bot;
}

export async function startBot(bot: Bot): Promise<RunnerHandle> {
  const me = await bot.api.getMe();
  logger.info({ username: me.username, id: me.id }, 'Telegram bot online');
  return run(bot);
}
