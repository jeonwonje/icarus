import path from 'path';
import { readEnvFile } from './env.js';

const envConfig = readEnvFile([
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHANNEL_PERSONAL',
  'TELEGRAM_CHANNEL_ACADEMIC',
  'TELEGRAM_CHANNEL_WORK',
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
export const TELEGRAM_CHANNEL_PERSONAL = fromEnv('TELEGRAM_CHANNEL_PERSONAL') || '';
export const TELEGRAM_CHANNEL_ACADEMIC = fromEnv('TELEGRAM_CHANNEL_ACADEMIC') || '';
export const TELEGRAM_CHANNEL_WORK = fromEnv('TELEGRAM_CHANNEL_WORK') || '';

export type ChannelName = 'personal' | 'academic' | 'work';

export const CHANNELS: Record<ChannelName, string> = {
  personal: TELEGRAM_CHANNEL_PERSONAL,
  academic: TELEGRAM_CHANNEL_ACADEMIC,
  work: TELEGRAM_CHANNEL_WORK,
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
