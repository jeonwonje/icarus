import path from 'path';
import { readEnvFile } from './env.js';

const envConfig = readEnvFile([
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_SUPERGROUP_ID',
  'TELEGRAM_TOPIC_PERSONAL',
  'TELEGRAM_TOPIC_ACADEMIC',
  'TELEGRAM_TOPIC_WORK',
  'CANVAS_API_TOKEN',
  'CANVAS_BASE_URL',
  'OUTLOOK_PST_PATH',
  'HUB_DIR',
  'ASSISTANT_NAME',
  'LIVENESS_STALE_MS',
  'LIVENESS_CHECK_INTERVAL_MS',
]);

function fromEnv(key: string): string | undefined {
  return process.env[key] || envConfig[key];
}

export const PROJECT_ROOT = process.cwd();

export const TELEGRAM_BOT_TOKEN = fromEnv('TELEGRAM_BOT_TOKEN') || '';

// One forum supergroup holds the three channels as forum topics. Messages are
// routed by (supergroup chat id, message_thread_id) → channel.
export const TELEGRAM_SUPERGROUP_ID = fromEnv('TELEGRAM_SUPERGROUP_ID') || '';

export type ChannelName = 'personal' | 'academic' | 'work';

// channel name → forum topic thread id (kept as a string, matched against
// the message's message_thread_id at runtime).
export const TOPICS: Record<ChannelName, string> = {
  personal: fromEnv('TELEGRAM_TOPIC_PERSONAL') || '',
  academic: fromEnv('TELEGRAM_TOPIC_ACADEMIC') || '',
  work: fromEnv('TELEGRAM_TOPIC_WORK') || '',
};

export const CANVAS_API_TOKEN = fromEnv('CANVAS_API_TOKEN') || '';
export const CANVAS_BASE_URL = fromEnv('CANVAS_BASE_URL') || '';
export const OUTLOOK_PST_PATH = fromEnv('OUTLOOK_PST_PATH') || '';

export const ASSISTANT_NAME = fromEnv('ASSISTANT_NAME') || 'Icarus';

// Hub: agent cwd + single source of truth. Defaults to <project>/hub.
export const HUB_DIR = path.resolve(PROJECT_ROOT, fromEnv('HUB_DIR') || 'hub');

export const STATE_DIR = path.join(HUB_DIR, 'state');
export const DB_PATH = path.join(STATE_DIR, 'sessions.db');

export const AGENT_TIMEOUT_MS = 30 * 60 * 1000; // 30 min hard cap per turn
export const AGENT_IDLE_TIMEOUT_MS = 10 * 60 * 1000; // kill if no output for 10 min

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
export const LIVENESS_STALE_MS = parsePositiveInt(fromEnv('LIVENESS_STALE_MS'), 3 * 60 * 1000);
export const LIVENESS_CHECK_INTERVAL_MS = parsePositiveInt(
  fromEnv('LIVENESS_CHECK_INTERVAL_MS'),
  30 * 1000,
);
