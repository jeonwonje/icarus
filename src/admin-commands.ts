import { TELEGRAM_CHAT_ID } from './config.js';

export interface AdminCtx {
  threadId: number;
  command: string;
  args: string;
}

export interface AdminResult {
  handled: boolean;
  reply?: string;
}

export function handlePing(): AdminResult {
  return { handled: true, reply: 'pong' };
}

export function handleChatId(threadId: number): AdminResult {
  return {
    handled: true,
    reply: `chat_id: ${TELEGRAM_CHAT_ID}\nthread_id: ${threadId}\nJID: tg:${TELEGRAM_CHAT_ID}:${threadId}`,
  };
}

export function handleHelp(): AdminResult {
  const lines = [
    '*Admin commands*',
    '/chatid — show chat + thread IDs',
    '/ping — health check',
    '',
    'Any other /command (e.g. /compact, /model, /clear) is forwarded to the claude subprocess.',
  ];
  return { handled: true, reply: lines.join('\n') };
}

export async function handleAdminCommand(ctx: AdminCtx): Promise<AdminResult> {
  const { threadId, command } = ctx;
  switch (command) {
    case 'ping':
      return handlePing();
    case 'chatid':
      return handleChatId(threadId);
    case 'help':
      return handleHelp();
    default:
      return { handled: false };
  }
}
