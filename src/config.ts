import path from 'path';

import { readEnvFile } from './env.js';

const envConfig = readEnvFile(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']);

function fromEnv(key: string): string | undefined {
  return process.env[key] || envConfig[key];
}

export const TELEGRAM_BOT_TOKEN = fromEnv('TELEGRAM_BOT_TOKEN') || '';
export const TELEGRAM_CHAT_ID = fromEnv('TELEGRAM_CHAT_ID') || '';

const PROJECT_ROOT = process.cwd();
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
const STATE_DIR = path.resolve(PROJECT_ROOT, 'state');
export const DB_PATH = path.join(STATE_DIR, 'messages.db');

// Agent subprocess behaviour
export const AGENT_TIMEOUT_MS = 30 * 60 * 1000; // 30 min hard cap per turn
export const AGENT_IDLE_TIMEOUT_MS = 10 * 60 * 1000; // kill if no output for 10 min
