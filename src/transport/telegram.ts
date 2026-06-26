import fs from 'fs';
import path from 'path';

import { Bot, InputFile, type Api } from 'grammy';
import { run, type RunnerHandle } from '@grammyjs/runner';

import {
  TOPICS,
  TELEGRAM_SUPERGROUP_ID,
  TELEGRAM_BOT_TOKEN,
  type ChannelName,
} from '../core/config.js';
import { logger } from '../core/logger.js';
import { rawDir } from '../memory/scaffold.js';
import { sanitizeFileName } from '../core/slug.js';

export interface ChannelMessage {
  channel: ChannelName;
  chatId: number;
  threadId: number; // forum topic thread id — replies go back to this topic
  senderId: string;
  senderName: string | null;
  content: string;
  isCommand: boolean;
  command?: string;
  commandArgs?: string;
}

export interface TelegramHandlers {
  onChannelMessage: (m: ChannelMessage) => Promise<void>;
}

/**
 * Map an incoming message to one of the three channels by (supergroup chat id,
 * forum topic thread id), or null if it isn't in a configured supergroup topic.
 */
export function channelForMessage(
  chatId: string | number,
  threadId: number | undefined,
): ChannelName | null {
  if (!TELEGRAM_SUPERGROUP_ID || String(chatId) !== TELEGRAM_SUPERGROUP_ID) return null;
  if (threadId === undefined) return null;
  const tid = String(threadId);
  for (const name of ['personal', 'academic', 'work'] as ChannelName[]) {
    if (TOPICS[name] && TOPICS[name] === tid) return name;
  }
  return null;
}

function senderDisplay(from: { first_name?: string; username?: string } | undefined): string | null {
  if (!from) return null;
  return from.username ? `@${from.username}` : from.first_name ?? null;
}

export function createBot(handlers: TelegramHandlers): Bot {
  const bot = new Bot(TELEGRAM_BOT_TOKEN);

  bot.on('message', async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;

    const message = ctx.message as unknown as Record<string, unknown>;
    const threadId = message.message_thread_id as number | undefined;
    const channel = channelForMessage(chatId, threadId);
    if (!channel) return; // ignore anything outside the configured supergroup topics

    const text = (message.text as string | undefined) ?? (message.caption as string | undefined) ?? '';

    // Download any attachment into the hub inbox (raw/ root).
    await maybeDownloadAttachment(ctx.api, message);

    if (!text && !message.document && !message.photo) return;

    const entities = (message.entities as Array<{ type: string; offset: number }> | undefined) ?? [];
    const isCommand = entities.some((e) => e.type === 'bot_command' && e.offset === 0);
    let command: string | undefined;
    let commandArgs: string | undefined;
    if (isCommand) {
      const m = text.match(/^\/(\w+)(?:@\S+)?\s*(.*)$/s);
      if (m) {
        command = m[1];
        commandArgs = m[2];
      }
    }

    const from = ctx.from as { id?: number; first_name?: string; username?: string } | undefined;

    const msg: ChannelMessage = {
      channel,
      chatId,
      threadId: threadId as number, // non-null: channelForMessage matched a topic
      senderId: String(from?.id ?? ''),
      senderName: senderDisplay(from),
      content: text || '(file uploaded)',
      isCommand,
      command,
      commandArgs,
    };
    try {
      await handlers.onChannelMessage(msg);
    } catch (err) {
      logger.error({ channel, err }, 'onChannelMessage failed');
    }
  });

  return bot;
}

async function maybeDownloadAttachment(api: Api, message: Record<string, unknown>): Promise<void> {
  const doc = message.document as { file_id: string; file_name?: string } | undefined;
  const photos = message.photo as { file_id: string }[] | undefined;
  try {
    if (doc) {
      await downloadToInbox(api, doc.file_id, doc.file_name ?? `${doc.file_id}.bin`);
    } else if (photos && photos.length) {
      const largest = photos[photos.length - 1];
      await downloadToInbox(api, largest.file_id, `${largest.file_id}.jpg`);
    }
  } catch (err) {
    logger.warn({ err }, 'attachment download failed');
  }
}

async function downloadToInbox(api: Api, fileId: string, fileName: string): Promise<void> {
  const file = await api.getFile(fileId);
  if (!file.file_path) return;
  const url = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${file.file_path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const dir = rawDir();
  fs.mkdirSync(dir, { recursive: true });
  const safe = sanitizeFileName(fileName);
  let dest = path.join(dir, safe);
  if (fs.existsSync(dest)) dest = path.join(dir, `${Date.now()}_${safe}`);
  fs.writeFileSync(dest, buf);
  logger.info({ file: path.basename(dest) }, 'attachment saved to inbox');
}

export async function startBot(bot: Bot): Promise<RunnerHandle> {
  await bot.init();
  return run(bot);
}

export async function sendText(
  api: Api,
  chatId: number,
  threadId: number,
  text: string,
): Promise<void> {
  // Telegram caps messages at 4096 chars; chunk longer outputs.
  const max = 4000;
  for (let i = 0; i < text.length; i += max) {
    await api.sendMessage(chatId, text.slice(i, i + max), { message_thread_id: threadId });
  }
}

export async function sendFile(
  api: Api,
  chatId: number,
  threadId: number,
  absPath: string,
  kind: 'document' | 'photo',
  caption?: string,
): Promise<void> {
  const file = new InputFile(absPath);
  const opts = { message_thread_id: threadId, ...(caption ? { caption } : {}) };
  if (kind === 'photo') await api.sendPhoto(chatId, file, opts);
  else await api.sendDocument(chatId, file, opts);
}

export function startTyping(api: Api, chatId: number, threadId: number): () => void {
  const tick = () =>
    api.sendChatAction(chatId, 'typing', { message_thread_id: threadId }).catch(() => {});
  tick();
  const h = setInterval(tick, 5000);
  return () => clearInterval(h);
}
