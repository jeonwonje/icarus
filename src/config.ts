import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { telegramConfigState } from './connectors/telegram/setupEnv.js';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const DESKTOP = path.resolve(ROOT, '..');

export const MODEL_ALIASES: Record<string, string> = {
  sonnet: 'claude-sonnet-5',
  opus: 'claude-opus-4-8',
  haiku: 'claude-haiku-4-5-20251001',
};

export function resolveModel(nameOrAlias: string): string {
  return MODEL_ALIASES[nameOrAlias] ?? nameOrAlias;
}

const SELFTEST = process.argv.includes('--selftest');

const envFile = path.join(ROOT, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const Env = z.object({
  TELEGRAM_BOT_TOKEN: SELFTEST ? z.string().default('selftest') : z.string().min(10),
  TELEGRAM_OWNER_ID: SELFTEST ? z.coerce.number().default(0) : z.coerce.number().int().positive(),
  CLAUDE_CODE_OAUTH_TOKEN: SELFTEST ? z.string().default('selftest') : z.string().min(10),
  ICARUS_MODEL: z.string().default('sonnet'),
  ICARUS_TZ: z.string().optional(),
  ICARUS_MAIL_DROP: z.string().optional(),
  CANVAS_BASE_URL: z.string().optional(),
  CANVAS_API_TOKEN: z.string().optional(),
  TG_API_ID: z.preprocess((v) => (v === '' || v == null ? undefined : Number(v)), z.number().int().positive().optional()),
  TG_API_HASH: z.string().optional(),
  TG_SESSION: z.string().optional(),
});

const env = Env.parse(process.env);
const tgConfigState = telegramConfigState({
  apiId: env.TG_API_ID,
  apiHash: env.TG_API_HASH || undefined,
  session: env.TG_SESSION || undefined,
});

export const cfg = {
  selftest: SELFTEST,
  botToken: env.TELEGRAM_BOT_TOKEN,
  ownerId: env.TELEGRAM_OWNER_ID,
  oauthToken: env.CLAUDE_CODE_OAUTH_TOKEN,
  defaultModel: env.ICARUS_MODEL,
  tz: env.ICARUS_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
  mailDropDir: env.ICARUS_MAIL_DROP || undefined,
  canvasBaseUrl: (env.CANVAS_BASE_URL || '').replace(/\/$/, '') || undefined,
  canvasApiToken: env.CANVAS_API_TOKEN || undefined,

  tgApiId: env.TG_API_ID,
  tgApiHash: env.TG_API_HASH || undefined,
  tgSession: env.TG_SESSION || undefined,
  tgConfigState,
  telegramArchiveDir: path.join(ROOT, 'archive', 'telegram'),

  desktopDir: DESKTOP,
  wikiDir: path.join(DESKTOP, 'wiki'),
  memoryDir: path.join(DESKTOP, 'wiki', 'memory'),
  indexPath: path.join(DESKTOP, 'index.md'),
  logPath: path.join(DESKTOP, 'log.md'),
  projectsDir: path.join(DESKTOP, '1_Projects'),
  personaDir: path.join(ROOT, 'persona'),
  evalCasesDir: path.join(ROOT, 'evals', 'cases'),
  inboxDir: path.join(DESKTOP, '0_Inbox'),
  outboxDir: path.join(DESKTOP, 'outbox'),
  artifactsDir: path.join(DESKTOP, '3_General', 'artifacts'),
  stateDir: path.join(ROOT, 'state'),
  logsDir: path.join(ROOT, 'state', 'logs'),
  proposalsDir: path.join(ROOT, 'state', 'proposals'),
  dbPath: path.join(ROOT, 'state', 'icarus.db'),
  shutdownMarker: path.join(ROOT, 'state', '.clean-shutdown'),

  hardCapMs: 30 * 60_000,
  reflectionCapMs: 45 * 60_000,
  idleCapMs: 10 * 60_000,
};

/** Env for Claude Agent SDK calls — OAuth token only, never ANTHROPIC_API_KEY. */
export function buildSdkEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_CODE_OAUTH_TOKEN: cfg.oauthToken,
  };
  delete env.ANTHROPIC_API_KEY;
  return env;
}

export const OWNER_JID = 'dm:owner';
export const REFLECTION_JOB = 'reflection';
export const MEMORY_JOB = 'memory-consolidation';
export const PROJECT_SWEEP_JOB = 'tg-project-sweep';
