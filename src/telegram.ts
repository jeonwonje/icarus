import { Bot, InputFile, type Api, type Context } from 'grammy';
import { run, sequentialize, type RunnerHandle } from '@grammyjs/runner';

import { OPERATOR_USER_ID, TELEGRAM_BOT_TOKEN } from './config.js';
import { insertMessage } from './db.js';
import { logger } from './logger.js';

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

      const content = ctx.message?.text ?? ctx.message?.caption ?? '';
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
