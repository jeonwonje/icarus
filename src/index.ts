import { setDefaultResultOrder } from 'node:dns';

import { Bot } from 'grammy';

// WSL2 (and some IPv6-broken hosts) can resolve api.telegram.org to an IPv6
// address that refuses connections, causing Grammy to hang until ETIMEDOUT.
// Force IPv4-first so outbound HTTPS picks a reachable route.
setDefaultResultOrder('ipv4first');

import { handleAdminCommand } from './admin-commands.js';
import { runAgent } from './agent-runner.js';
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
import { dataDir, ensureDataLayout } from './memory/scaffold.js';
import { TopicMutex } from './mutex.js';
import {
  createBot,
  sendFile,
  sendText,
  startBot,
  startTyping,
  type InboundMessage,
} from './telegram.js';

const LIFE = 'life';
const mutex = new TopicMutex();
const pendingMessages: InboundMessage[] = [];

async function drainOutbox(bot: Bot, msg: InboundMessage): Promise<void> {
  const files = listOutbox();
  for (const f of files) {
    try {
      await sendFile(bot.api, msg.chatId, f.absPath, f.fileType, f.caption);
      removeOutboxFile(f);
    } catch (err) {
      logger.error({ file: f.filename, err }, 'outbox send failed');
    }
  }
}

const SLASH_RE = /^\/[A-Za-z][\w-]*(?:\s|$)/;

async function runTurn(
  bot: Bot,
  msg: InboundMessage,
  promptOverride?: string,
): Promise<void> {
  const prompt = promptOverride ?? msg.content;
  const sessionId = getSession() ?? undefined;
  const isSlashCommand = SLASH_RE.test(prompt.trim());
  const finalPrompt = isSlashCommand ? prompt : buildBootstrapPrefix() + prompt;

  const stopTyping = startTyping(bot.api, msg.chatId);

  try {
    let lastSent = '';
    let sentAny = false;
    const result = await runAgent(
      { prompt: finalPrompt, sessionId, cwd: dataDir() },
      async (ev) => {
        if (ev.newSessionId) setSession(ev.newSessionId);
        if (ev.status === 'success' && ev.result && ev.result !== lastSent) {
          lastSent = ev.result;
          sentAny = true;
          try {
            await sendText(bot.api, msg.chatId, ev.result);
          } catch (err) {
            logger.error({ err }, 'sendMessage failed');
          }
        }
      },
    );

    if (result.status === 'error') {
      await sendText(
        bot.api,
        msg.chatId,
        `[agent error] ${result.error ?? 'unknown failure'}`,
      );
    } else if (!sentAny && result.result) {
      await sendText(bot.api, msg.chatId, result.result);
    }

    await drainOutbox(bot, msg);

    const summary = (result.result ?? '').slice(0, 180).replace(/\s+/g, ' ');
    if (summary) appendLogEntry(summary);
  } finally {
    stopTyping();
  }
}

async function onMessage(bot: Bot, msg: InboundMessage): Promise<void> {
  // Route bot-local commands without spawning the agent.
  if (msg.isCommand && msg.command) {
    const adminRes = await handleAdminCommand({
      command: msg.command,
      args: msg.commandArgs ?? '',
      callerUserId: msg.senderId,
    });
    if (adminRes.handled) {
      if (adminRes.reply) {
        await sendText(bot.api, msg.chatId, adminRes.reply);
      }
      return;
    }
    // Unknown /command — pass through to claude CLI below.
  }

  if (mutex.isLocked(LIFE)) {
    pendingMessages.push(msg);
    return;
  }

  await mutex.acquire(LIFE);
  try {
    await runTurn(bot, msg);
    for (;;) {
      if (pendingMessages.length === 0) break;
      const drained = pendingMessages.splice(0, pendingMessages.length);
      const combined = drained
        .map((p) => `[from ${p.senderName ?? p.senderId}] ${p.content}`)
        .join('\n\n');
      await runTurn(bot, { ...msg, content: combined }, combined);
    }
  } finally {
    mutex.release(LIFE);
  }
}

async function main(): Promise<void> {
  ensureDataLayout();
  openDb();

  const bot = createBot({
    onMessage: (msg) => onMessage(bot, msg),
  });

  // Record bot-authored outbound messages for history.
  bot.api.config.use(async (prev, method, payload, signal) => {
    const res = await prev(method, payload, signal);
    if (method === 'sendMessage' || method === 'sendDocument' || method === 'sendPhoto') {
      const p = payload as Record<string, unknown>;
      const text = (method === 'sendMessage' ? (p.text as string) : (p.caption as string)) ?? '';
      if (text) {
        insertMessage({
          telegramMsgId: `bot_${Date.now()}`,
          senderId: 'bot',
          senderName: 'bot',
          content: text,
          timestamp: new Date().toISOString(),
          isBot: true,
        });
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

  await handle.task();
}

main().catch((err) => {
  logger.fatal({ err }, 'fatal');
  process.exit(1);
});
