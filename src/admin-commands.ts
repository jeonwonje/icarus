import path from 'path';

import { CANVAS_API_TOKEN, CANVAS_BASE_URL, CANVAS_COURSES, OPERATOR_USER_ID } from './config.js';
import { syncCanvas } from './canvas.js';
import { rawDir } from './memory/scaffold.js';

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
    '/canvas — sync NUS Canvas files into read-only raw/canvas/',
    '',
    'Any other /command (e.g. /compact, /model, /clear) is forwarded to the claude subprocess.',
  ];
  return { handled: true, reply: lines.join('\n') };
}

/**
 * Sync NUS Canvas files into read-only raw/canvas/. Runs in the bot process so
 * the token never reaches the sandboxed claude subprocess. `token` is injectable
 * for tests; it defaults to the configured CANVAS_API_TOKEN.
 */
export async function handleCanvas(token: string = CANVAS_API_TOKEN): Promise<AdminResult> {
  if (!token) {
    return { handled: true, reply: 'Canvas not configured (set CANVAS_API_TOKEN in .env).' };
  }
  try {
    const s = await syncCanvas(
      { baseUrl: CANVAS_BASE_URL, token },
      { canvasDir: path.join(rawDir(), 'canvas'), coursesFilter: CANVAS_COURSES },
    );
    const mb = (s.bytes / 1e6).toFixed(1);
    let reply = `Canvas: ${s.downloaded} new, ${s.skipped} unchanged, ${s.failed} failed across ${s.courses} courses · ${mb} MB`;
    if (s.errors.length) {
      reply += `\nErrors:\n- ${s.errors.slice(0, 5).join('\n- ')}`;
    }
    return { handled: true, reply };
  } catch (err) {
    return { handled: true, reply: `Canvas sync error: ${(err as Error).message}` };
  }
}

export async function handleAdminCommand(ctx: AdminCtx): Promise<AdminResult> {
  switch (ctx.command) {
    case 'ping':
      return handlePing();
    case 'whoami':
      return handleWhoami(ctx.callerUserId);
    case 'help':
      return handleHelp();
    case 'canvas':
      return handleCanvas();
    default:
      return { handled: false };
  }
}
