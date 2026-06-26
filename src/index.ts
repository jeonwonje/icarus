import { setDefaultResultOrder } from 'node:dns';
setDefaultResultOrder('ipv4first');

import type { Bot } from 'grammy';

import { runAgent } from './agent/runner.js';
import { getModelOptions, setClaudeModel } from './agent/claude-config.js';
import type { TurnMeta } from './agent/types.js';
import { openDb } from './db/db.js';
import { logger } from './core/logger.js';
import { TOPICS, TELEGRAM_SUPERGROUP_ID, TELEGRAM_BOT_TOKEN } from './core/config.js';
import { ChannelMutex } from './core/mutex.js';
import { appendLogEntry } from './memory/log.js';
import { listOutbox, removeOutboxFile } from './memory/outbox.js';
import { ensureHubLayout } from './memory/scaffold.js';
import {
  createBot,
  sendFile,
  sendText,
  startBot,
  startTyping,
  type ChannelMessage,
} from './transport/telegram.js';

const mutex = new ChannelMutex();
const pending = new Map<string, ChannelMessage[]>();

async function drainOutbox(bot: Bot, msg: ChannelMessage): Promise<void> {
  for (const f of listOutbox(msg.channel)) {
    try {
      await sendFile(bot.api, msg.chatId, msg.threadId, f.absPath, f.kind, f.caption);
      removeOutboxFile(f);
    } catch (err) {
      logger.error({ channel: msg.channel, file: f.filename, err }, 'outbox send failed');
    }
  }
}

async function runTurn(bot: Bot, msg: ChannelMessage, promptOverride?: string): Promise<void> {
  const prompt = promptOverride ?? msg.content;
  const meta: TurnMeta = {
    channel: msg.channel,
    senderId: msg.senderId,
    senderName: msg.senderName,
  };
  const stopTyping = startTyping(bot.api, msg.chatId, msg.threadId);
  try {
    let lastSent = '';
    let sentAny = false;
    const result = await runAgent(msg.channel, { prompt, meta }, async (ev) => {
      if (ev.status === 'success' && ev.result && ev.result !== lastSent) {
        lastSent = ev.result;
        sentAny = true;
        try {
          await sendText(bot.api, msg.chatId, msg.threadId, ev.result);
        } catch (err) {
          logger.error({ channel: msg.channel, err }, 'sendText failed');
        }
      }
    });

    if (result.status === 'error') {
      await sendText(
        bot.api,
        msg.chatId,
        msg.threadId,
        `[agent error] ${result.error ?? 'unknown failure'}`,
      );
    } else if (!sentAny && result.result) {
      await sendText(bot.api, msg.chatId, msg.threadId, result.result);
    }

    await drainOutbox(bot, msg);
    if (result.result) appendLogEntry(result.result);
  } finally {
    stopTyping();
  }
}

async function handleModelCommand(bot: Bot, msg: ChannelMessage): Promise<boolean> {
  if (msg.command !== 'model') return false;
  const arg = (msg.commandArgs ?? '').trim();
  if (!arg) {
    const list = getModelOptions().map((o) => `- ${o.id} — ${o.label}`).join('\n');
    await sendText(bot.api, msg.chatId, msg.threadId, `Models:\n${list}\n\nUse /model <id> to switch.`);
  } else {
    setClaudeModel(arg === 'default' ? null : arg);
    await sendText(bot.api, msg.chatId, msg.threadId, `Model set to ${arg}.`);
  }
  return true;
}

async function onChannelMessage(bot: Bot, msg: ChannelMessage): Promise<void> {
  if (msg.isCommand && (await handleModelCommand(bot, msg))) return;

  if (mutex.isLocked(msg.channel)) {
    const q = pending.get(msg.channel) ?? [];
    q.push(msg);
    pending.set(msg.channel, q);
    return;
  }

  await mutex.acquire(msg.channel);
  try {
    await runTurn(bot, msg);
    for (;;) {
      const queued = pending.get(msg.channel) ?? [];
      if (queued.length === 0) break;
      pending.set(msg.channel, []);
      const combined = queued
        .map((p) => `[from ${p.senderName ?? p.senderId}] ${p.content}`)
        .join('\n\n');
      await runTurn(bot, { ...msg, content: combined }, combined);
    }
  } finally {
    mutex.release(msg.channel);
  }
}

async function main(): Promise<void> {
  const missingKeys: string[] = [];
  if (!TELEGRAM_BOT_TOKEN) missingKeys.push('TELEGRAM_BOT_TOKEN');
  if (!TELEGRAM_SUPERGROUP_ID) missingKeys.push('TELEGRAM_SUPERGROUP_ID');
  if (!TOPICS.personal) missingKeys.push('TELEGRAM_TOPIC_PERSONAL');
  if (!TOPICS.academic) missingKeys.push('TELEGRAM_TOPIC_ACADEMIC');
  if (!TOPICS.work) missingKeys.push('TELEGRAM_TOPIC_WORK');
  if (missingKeys.length > 0) {
    logger.fatal({ missingKeys }, `missing required config: ${missingKeys.join(', ')}`);
    process.exit(1);
  }

  ensureHubLayout();
  openDb();

  const bot = createBot({ onChannelMessage: (m) => onChannelMessage(bot, m) });
  const handle = await startBot(bot);
  logger.info('icarus started');

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
