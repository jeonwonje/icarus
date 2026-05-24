import { OPERATOR_USER_ID } from './config.js';

export interface AdminCtx {
  command: string;
  args: string;
  callerUserId: string;
}

export interface AdminResult {
  handled: boolean;
  reply?: string;
}

export function handlePing(): AdminResult {
  return { handled: true, reply: 'pong' };
}

export function handleWhoami(callerUserId: string): AdminResult {
  const isOperator = OPERATOR_USER_ID && callerUserId === OPERATOR_USER_ID;
  const status = OPERATOR_USER_ID
    ? isOperator
      ? '(configured operator)'
      : `(not the configured operator — operator is ${OPERATOR_USER_ID})`
    : '(no operator configured — paste this into OPERATOR_USER_ID and restart)';
  return {
    handled: true,
    reply: `your_user_id: ${callerUserId} ${status}`,
  };
}

export function handleHelp(): AdminResult {
  const lines = [
    '*Commands*',
    '/whoami — show your user id and operator status',
    '/ping — health check',
    '',
    'Any other /command (e.g. /compact, /model, /clear) is forwarded to the claude subprocess.',
  ];
  return { handled: true, reply: lines.join('\n') };
}

export async function handleAdminCommand(ctx: AdminCtx): Promise<AdminResult> {
  switch (ctx.command) {
    case 'ping':
      return handlePing();
    case 'whoami':
      return handleWhoami(ctx.callerUserId);
    case 'help':
      return handleHelp();
    default:
      return { handled: false };
  }
}
