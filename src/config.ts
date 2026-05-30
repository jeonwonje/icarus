import path from 'path';

import { readEnvFile } from './env.js';

const envConfig = readEnvFile(['TELEGRAM_BOT_TOKEN', 'OPERATOR_USER_ID', 'RAW_DIR', 'SANDBOX_MOUNTS']);

function fromEnv(key: string): string | undefined {
  return process.env[key] || envConfig[key];
}

export const TELEGRAM_BOT_TOKEN = fromEnv('TELEGRAM_BOT_TOKEN') || '';
export const OPERATOR_USER_ID = fromEnv('OPERATOR_USER_ID') || '';

const PROJECT_ROOT = process.cwd();
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
const STATE_DIR = path.resolve(PROJECT_ROOT, 'state');
export const DB_PATH = path.join(STATE_DIR, 'messages.db');

// raw/ source tree. Symlinked from data/raw to this path (default: Windows
// Desktop so files are browsable from Windows). Override via RAW_DIR in .env.
export const RAW_DIR = fromEnv('RAW_DIR') || '/mnt/c/Users/jeonw/Desktop/icarus-raw';

// Extra directories bind-mounted read-write into the agent sandbox and surfaced
// as raw/<name>. Format: `name=abspath` entries separated by ';'. Parsed by
// parseSandboxMounts in sandbox.ts.
export const SANDBOX_MOUNTS = fromEnv('SANDBOX_MOUNTS') || '';

// Telegram's cloud Bot API caps file downloads at 20 MB; larger files fail at
// getFile(), so we detect and warn instead of attempting the download.
export const TELEGRAM_BOT_DOWNLOAD_LIMIT_BYTES = 20 * 1024 * 1024;

// Agent subprocess behaviour
export const AGENT_TIMEOUT_MS = 30 * 60 * 1000; // 30 min hard cap per turn
export const AGENT_IDLE_TIMEOUT_MS = 10 * 60 * 1000; // kill if no output for 10 min
