import { Bot, InlineKeyboard, InputFile } from 'grammy';
import path from 'node:path';
import { ownerVoice } from '../agent/ownerVoice.js';
import { cfg } from '../config.js';
import { log } from '../log.js';

let bot: Bot;

export function setBot(b: Bot): void {
  bot = b;
}

const MAX_CHUNK = 4000;

/** Split on paragraph, then line, then hard boundaries to fit Telegram's message cap. */
export function chunkText(text: string): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > MAX_CHUNK) {
    let cut = rest.lastIndexOf('\n\n', MAX_CHUNK);
    if (cut < MAX_CHUNK / 2) cut = rest.lastIndexOf('\n', MAX_CHUNK);
    if (cut < MAX_CHUNK / 2) cut = MAX_CHUNK;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export async function sendOwner(text: string): Promise<void> {
  if (!text.trim()) return;
  for (const chunk of chunkText(text)) {
    try {
      await bot.api.sendMessage(cfg.ownerId, chunk);
    } catch (e) {
      log.error({ err: String(e) }, 'sendOwner failed');
    }
  }
}

export async function sendOwnerDocument(filePath: string, caption?: string): Promise<void> {
  try {
    await bot.api.sendDocument(cfg.ownerId, new InputFile(filePath), {
      caption: caption?.slice(0, 1000),
    });
  } catch (e) {
    log.error({ err: String(e), filePath }, 'sendOwnerDocument failed');
    await sendOwner(ownerVoice.ops.sendDocumentFailed(path.basename(filePath), String(e)));
  }
}

export async function sendOwnerKeyboard(text: string, keyboard: InlineKeyboard): Promise<void> {
  const chunks = chunkText(text);
  for (let i = 0; i < chunks.length; i++) {
    try {
      await bot.api.sendMessage(cfg.ownerId, chunks[i], {
        reply_markup: i === chunks.length - 1 ? keyboard : undefined,
      });
    } catch (e) {
      log.error({ err: String(e) }, 'sendOwnerKeyboard failed');
    }
  }
}

/** Keep the typing indicator alive; returns a stop function. */
export function startTyping(): () => void {
  const tick = () => bot.api.sendChatAction(cfg.ownerId, 'typing').catch(() => {});
  tick();
  const t = setInterval(tick, 4000);
  return () => clearInterval(t);
}

/** Send a short-lived owner message with a keyboard; returns its id for later deletion. */
export async function sendOwnerEphemeral(text: string, keyboard: InlineKeyboard): Promise<number | null> {
  try {
    const m = await bot.api.sendMessage(cfg.ownerId, text, { reply_markup: keyboard });
    return m.message_id;
  } catch (e) {
    log.error({ err: String(e) }, 'sendOwnerEphemeral failed');
    return null;
  }
}

export async function deleteOwnerMessage(messageId: number): Promise<void> {
  await bot.api.deleteMessage(cfg.ownerId, messageId).catch(() => {
    /* already gone — fine */
  });
}
