import { setDefaultResultOrder } from 'node:dns';

import { Bot } from 'grammy';

// WSL2 (and some IPv6-broken hosts) can resolve api.telegram.org to an IPv6
// address that refuses connections, causing Grammy to hang until ETIMEDOUT.
// Force IPv4-first so outbound HTTPS picks a reachable route.
setDefaultResultOrder('ipv4first');

import { handleAdminCommand } from './admin-commands.js';
import { runAgent } from './agent-runner.js';
import { TELEGRAM_CHAT_ID } from './config.js';
import {
  getSession,
  insertMessage,
  openDb,
  setSession,
} from './db.js';
import { logger } from './logger.js';
import { buildBootstrapPrefix } from './memory/bootstrap.js';
import { appendLogEntry } from './memory/log.js';
import { listOutbox, removeOutboxFile } from './memory/outbox.js';
import { ensureDataLayout } from './memory/scaffold.js';
import { ensureThreadLayout, threadDir } from './memory/threads.js';
import { TopicMutex } from './mutex.js';
import {
  createBot,
  sendFileToTopic,
  sendTextToTopic,
  startBot,
  startTyping,
  type ThreadMessage,
} from './telegram.js';

const mutex = new TopicMutex();
const pendingByThread = new Map<string, ThreadMessage[]>();

async function drainOutbox(bot: Bot, msg: ThreadMessage): Promise<void> {
  const files = listOutbox(msg.threadJid);
  for (const f of files) {
    try {
      await sendFileToTopic(bot.api, msg.chatId, msg.threadId, f.absPath, f.fileType, f.caption);
      removeOutboxFile(f);
    } catch (err) {
      logger.error({ threadJid: msg.threadJid, file: f.filename, err }, 'outbox send failed');
    }
  }
}

const SLASH_RE = /^\/[A-Za-z][\w-]*(?:\s|$)/;

async function runTurn(
  bot: Bot,
  msg: ThreadMessage,
  promptOverride?: string,
): Promise<void> {
  const prompt = promptOverride ?? msg.content;
  ensureThreadLayout(msg.threadJid);

  const sessionId = getSession(msg.threadJid) ?? undefined;
  const isSlashCommand = SLASH_RE.test(prompt.trim());
  const finalPrompt = isSlashCommand ? prompt : buildBootstrapPrefix(msg.threadJid) + prompt;

  const stopTyping = startTyping(bot.api, msg.chatId, msg.threadId);

  try {
    // Forward every assistant text the agent emits during the turn, not just
    // the first. This matters for tasks that dispatch a subagent and then
    // report back: the "Dispatching..." message and the final summary that
    // comes after the subagent returns must both reach Telegram.
    let lastSent = '';
    let sentAny = false;
    const result = await runAgent(
      msg.threadJid,
      { prompt: finalPrompt, sessionId, cwd: threadDir(msg.threadJid) },
      async (ev) => {
        if (ev.newSessionId) setSession(msg.threadJid, ev.newSessionId);
        if (ev.status === 'success' && ev.result && ev.result !== lastSent) {
          lastSent = ev.result;
          sentAny = true;
          try {
            await sendTextToTopic(bot.api, msg.chatId, msg.threadId, ev.result);
          } catch (err) {
            logger.error({ threadJid: msg.threadJid, err }, 'sendMessage failed');
          }
        }
      },
    );

    if (result.status === 'error') {
      await sendTextToTopic(
        bot.api,
        msg.chatId,
        msg.threadId,
        `[agent error] ${result.error ?? 'unknown failure'}`,
      );
    } else if (!sentAny && result.result) {
      // Final text arrived only at close time — still need to emit it.
      await sendTextToTopic(bot.api, msg.chatId, msg.threadId, result.result);
    }

    await drainOutbox(bot, msg);

    const summary = (result.result ?? '').slice(0, 180).replace(/\s+/g, ' ');
    if (summary) appendLogEntry(msg.threadJid, summary);
  } finally {
    stopTyping();
  }
}

async function onThreadMessage(bot: Bot, msg: ThreadMessage): Promise<void> {
  // Route admin-local commands without going through the agent.
  if (msg.isCommand && msg.command) {
    const adminRes = await handleAdminCommand({
      threadId: msg.threadId,
      command: msg.command,
      args: msg.commandArgs ?? '',
    });
    if (adminRes.handled) {
      if (adminRes.reply) {
        await sendTextToTopic(bot.api, msg.chatId, msg.threadId, adminRes.reply);
      }
      return;
    }
    // Unknown /command — treat as passthrough to claude CLI.
  }

  // Serialize per thread. If locked, queue the message and let the owner pick it up.
  if (mutex.isLocked(msg.threadJid)) {
    const queue = pendingByThread.get(msg.threadJid) ?? [];
    queue.push(msg);
    pendingByThread.set(msg.threadJid, queue);
    return;
  }

  await mutex.acquire(msg.threadJid);
  try {
    await runTurn(bot, msg);
    // Drain any messages that piled up during the turn.
    for (;;) {
      const pending = pendingByThread.get(msg.threadJid) ?? [];
      if (pending.length === 0) break;
      pendingByThread.set(msg.threadJid, []);
      const combined = pending
        .map((p) => `[from ${p.senderName ?? p.senderId}] ${p.content}`)
        .join('\n\n');
      await runTurn(bot, { ...msg, content: combined }, combined);
    }
  } finally {
    mutex.release(msg.threadJid);
  }
}

async function main(): Promise<void> {
  if (!TELEGRAM_CHAT_ID) {
    logger.warn(
      'TELEGRAM_CHAT_ID not set — starting in bootstrap mode. Send /chatid from inside your supergroup (or a forum topic) to get the ID, paste it into .env, and restart.',
    );
  }
  ensureDataLayout();
  openDb();

  const bot = createBot({
    onThreadMessage: (msg) => onThreadMessage(bot, msg),
  });

  // Record bot-authored outbound messages for history.
  bot.api.config.use(async (prev, method, payload, signal) => {
    const res = await prev(method, payload, signal);
    if (method === 'sendMessage' || method === 'sendDocument' || method === 'sendPhoto') {
      const p = payload as Record<string, unknown>;
      const threadId = typeof p.message_thread_id === 'number' ? p.message_thread_id : null;
      const chatIdRaw = p.chat_id;
      const chatId =
        typeof chatIdRaw === 'number' || typeof chatIdRaw === 'string'
          ? String(chatIdRaw)
          : '';
      if (threadId !== null && chatId) {
        const text = (method === 'sendMessage' ? (p.text as string) : (p.caption as string)) ?? '';
        if (text) {
          insertMessage({
            telegramMsgId: `bot_${Date.now()}`,
            chatJid: `tg:${chatId}:${threadId}`,
            threadId,
            senderId: 'bot',
            senderName: 'bot',
            content: text,
            timestamp: new Date().toISOString(),
            isBot: true,
          });
        }
      }
    }
    return res;
  });

  const handle = await startBot(bot);

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    try {
      await handle.stop();
    } catch (err) {
      logger.warn({ err }, 'runner stop failed');
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // Block until the runner is stopped — keeps the process alive.
  await handle.task();
}

main().catch((err) => {
  logger.fatal({ err }, 'fatal');
  process.exit(1);
});
