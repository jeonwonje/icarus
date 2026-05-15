import { Bot, InputFile, type Api, type Context } from 'grammy';
import { run, sequentialize, type RunnerHandle } from '@grammyjs/runner';

import { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } from './config.js';
import { insertMessage } from './db.js';
import { logger } from './logger.js';

export interface TelegramConfig {
  token: string;
  chatId: string;
}

export interface ThreadMessage {
  threadJid: string;     // tg:<chatId>:<threadId>
  threadId: number;
  chatId: number;
  senderId: string;
  senderName: string | null;
  content: string;
  isCommand: boolean;
  command?: string;
  commandArgs?: string;
  telegramMsgId: string;
}

export interface TelegramBotHandlers {
  /** Called on every admin message in a forum thread. Should not throw — runner handles errors. */
  onThreadMessage: (msg: ThreadMessage) => Promise<void>;
}

function buildJid(chatId: string | number, threadId: number): string {
  return `tg:${chatId}:${threadId}`;
}

// --- Admin gating ------------------------------------------------------

const adminCache = new Map<string, { adminIds: Set<string>; expiresAt: number }>();
const ADMIN_CACHE_TTL_MS = 5 * 60 * 1000;

async function isChatAdmin(
  api: Api,
  chatId: string | number,
  userId: string,
): Promise<boolean> {
  const key = String(chatId);
  const now = Date.now();
  const cached = adminCache.get(key);
  if (cached && cached.expiresAt > now) return cached.adminIds.has(userId);
  try {
    const admins = await api.getChatAdministrators(chatId);
    const adminIds = new Set(admins.map((m) => m.user.id.toString()));
    adminCache.set(key, { adminIds, expiresAt: now + ADMIN_CACHE_TTL_MS });
    return adminIds.has(userId);
  } catch (err) {
    logger.warn({ chatId, err }, 'Failed to fetch chat admins, allowing');
    return true;
  }
}

/**
 * The bot only acts for Telegram chat admins. Non-admins' messages are still
 * recorded to the DB by the caller, but the agent is not invoked for them.
 * Private chats with the bot are treated as admin (operator-direct).
 */
async function isAdmin(ctx: Context): Promise<boolean> {
  const from = ctx.from?.id;
  if (!from) return false;
  if (ctx.chat?.type === 'private') return true;
  if (!ctx.chat) return false;
  return isChatAdmin(ctx.api, ctx.chat.id, from.toString());
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

/**
 * Show "typing…" in the topic until the returned function is called.
 * Telegram chat actions auto-expire after ~5s, so we re-send every 4s.
 */
export function startTyping(
  api: Api,
  chatId: number | string,
  threadId: number,
): () => void {
  let stopped = false;
  const tick = (): void => {
    if (stopped) return;
    api
      .sendChatAction(chatId, 'typing', { message_thread_id: threadId })
      .catch(() => {
        /* indicator is best-effort; ignore */
      });
  };
  tick();
  const timer = setInterval(tick, 4000);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export async function sendTextToTopic(
  api: Api,
  chatId: number | string,
  threadId: number,
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
    const sent = await api.sendMessage(chatId, chunk, { message_thread_id: threadId });
    lastId = sent.message_id;
  }
  return lastId !== null ? { messageId: lastId } : null;
}

export async function sendFileToTopic(
  api: Api,
  chatId: number | string,
  threadId: number,
  absPath: string,
  kind: 'image' | 'document',
  caption?: string,
): Promise<void> {
  const input = new InputFile(absPath);
  const opts: { message_thread_id: number; caption?: string } = {
    message_thread_id: threadId,
  };
  if (caption) opts.caption = caption;
  if (kind === 'image') {
    await api.sendPhoto(chatId, input, opts);
  } else {
    await api.sendDocument(chatId, input, opts);
  }
}

// --- Main bot entrypoint ----------------------------------------------

export function createBot(handlers: TelegramBotHandlers): Bot {
  if (!TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN not set');
  // TELEGRAM_CHAT_ID may be empty during bootstrap — the middleware handles
  // that case by allowing all chats so /chatid can reveal the supergroup ID.
  const bot = new Bot(TELEGRAM_BOT_TOKEN);

  // Register the slash-command set shown in the autocomplete menu.
  bot.api
    .setMyCommands([
      { command: 'chatid', description: 'Show chat + thread IDs' },
      { command: 'ping', description: 'Health check' },
      { command: 'help', description: 'Show commands' },
    ])
    .catch((err) => logger.warn({ err }, 'setMyCommands failed'));

  // Serialize updates per forum thread (chat + thread), so rapid messages
  // within one thread process in order, while *different* threads run in
  // parallel.
  bot.use(
    sequentialize((ctx) => {
      const chat = ctx.chat?.id;
      if (chat === undefined) return undefined;
      const thread = ctx.msg?.message_thread_id ?? 0;
      return `${chat}:${thread}`;
    }),
  );

  // Gate the whole bot on the configured chat ID (and private chats with admins).
  // Bootstrap mode: when TELEGRAM_CHAT_ID is empty, allow all chats through so
  // the user can run /chatid to discover their supergroup ID.
  let bootstrapWarned = false;
  bot.use(async (ctx, next) => {
    if (!TELEGRAM_CHAT_ID) {
      if (!bootstrapWarned) {
        logger.warn({}, 'TELEGRAM_CHAT_ID not set — bootstrap mode, all chats allowed. Set it once you know the chat id.');
        bootstrapWarned = true;
      }
      await next();
      return;
    }
    if (ctx.chat && String(ctx.chat.id) !== String(TELEGRAM_CHAT_ID) && ctx.chat.type !== 'private') {
      return;
    }
    await next();
  });

  bot.on('message', async (ctx) => {
    try {
      const chatId = ctx.chat?.id;
      if (!chatId) return;
      const threadId = ctx.message?.message_thread_id;
      const senderId = String(ctx.from?.id ?? 'unknown');
      const senderName = ctx.from?.username || ctx.from?.first_name || null;

      const admin = await isAdmin(ctx);

      const text = ctx.message?.text;
      const parsed = parseCommand(text);

      // /chatid is admin-only and used during bootstrap to discover IDs.
      if (parsed?.command === 'chatid' && admin) {
        const tid = typeof threadId === 'number' ? threadId : 0;
        const uid = ctx.from?.id ?? 'unknown';
        const uname = ctx.from?.username ? `@${ctx.from.username}` : ctx.from?.first_name ?? '';
        const body =
          `chat_id: ${chatId}\n` +
          `thread_id: ${tid}\n` +
          (tid ? `JID: tg:${chatId}:${tid}\n` : '(not a forum topic, post inside a topic to get a thread_id)\n') +
          `your_user_id: ${uid}${uname ? ` (${uname})` : ''}`;
        await ctx.api.sendMessage(chatId, body, tid ? { message_thread_id: tid } : {});
        return;
      }

      if (typeof threadId !== 'number') {
        // Messages in the supergroup's "general" section have no thread; skip.
        return;
      }

      const threadJid = buildJid(chatId, threadId);
      const content = ctx.message?.text ?? ctx.message?.caption ?? '';

      // Non-admins: record the message text/caption for audit, but do not
      // invoke the agent.
      if (!admin) {
        insertMessage({
          telegramMsgId: String(ctx.message?.message_id ?? Date.now()),
          chatJid: threadJid,
          threadId,
          senderId,
          senderName,
          content,
          timestamp: new Date().toISOString(),
        });
        logger.debug({ senderId, threadId }, 'non-admin message recorded; agent not invoked');
        return;
      }

      // Admin path: record and hand off to the orchestrator.
      insertMessage({
        telegramMsgId: String(ctx.message?.message_id ?? Date.now()),
        chatJid: threadJid,
        threadId,
        senderId,
        senderName,
        content,
        timestamp: new Date().toISOString(),
      });

      await handlers.onThreadMessage({
        threadJid,
        threadId,
        chatId,
        senderId,
        senderName,
        content,
        isCommand: !!parsed,
        command: parsed?.command,
        commandArgs: parsed?.args,
        telegramMsgId: String(ctx.message?.message_id ?? ''),
      });
    } catch (err) {
      logger.error({ err }, 'Unhandled error in message handler');
      try {
        const threadId = ctx.message?.message_thread_id;
        const chatId = ctx.chat?.id;
        if (typeof threadId === 'number' && typeof chatId === 'number') {
          await sendTextToTopic(ctx.api, chatId, threadId, `[error: ${(err as Error).message ?? err}]`);
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

/**
 * Start the bot with grammY's concurrent runner. Returns a handle whose
 * `.task()` promise resolves only when the runner is stopped — the caller
 * awaits that to keep the process alive. Call `.stop()` for clean shutdown.
 */
export async function startBot(bot: Bot): Promise<RunnerHandle> {
  const me = await bot.api.getMe();
  logger.info({ username: me.username, id: me.id }, 'Telegram bot online');
  return run(bot);
}
