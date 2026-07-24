import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

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
  ICARUS_BROWSER_MCP: z.string().optional(),
  ICARUS_CALENDAR_MCP: z.string().optional(),
  TG_API_ID: z.preprocess((v) => (v === '' || v == null ? undefined : Number(v)), z.number().int().positive().optional()),
  TG_API_HASH: z.string().optional(),
  TG_SESSION: z.string().optional(),
});

const env = Env.parse(process.env);

const McpJson = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

function parseMcpJson(name: string, raw: string | undefined) {
  if (!raw) return undefined;
  try {
    return McpJson.parse(JSON.parse(raw));
  } catch (e) {
    throw new Error(`${name} is not valid JSON {command,args?,env?}: ${String(e).slice(0, 200)}`);
  }
}

export const cfg = {
  selftest: SELFTEST,
  botToken: env.TELEGRAM_BOT_TOKEN,
  ownerId: env.TELEGRAM_OWNER_ID,
  oauthToken: env.CLAUDE_CODE_OAUTH_TOKEN,
  defaultModel: env.ICARUS_MODEL,
  tz: env.ICARUS_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
  mailDropDir: env.ICARUS_MAIL_DROP || undefined,
  browserMcp: parseMcpJson('ICARUS_BROWSER_MCP', env.ICARUS_BROWSER_MCP),
  calendarMcp: parseMcpJson('ICARUS_CALENDAR_MCP', env.ICARUS_CALENDAR_MCP),

  tgApiId: env.TG_API_ID,
  tgApiHash: env.TG_API_HASH || undefined,
  tgSession: env.TG_SESSION || undefined,

  desktopDir: DESKTOP,
  wikiDir: path.join(DESKTOP, 'wiki'),
  memoryDir: path.join(DESKTOP, 'wiki', 'memory'),
  personaDir: path.join(ROOT, 'persona'),
  evalCasesDir: path.join(ROOT, 'evals', 'cases'),
  inboxDir: path.join(ROOT, 'inbox'),
  outboxDir: path.join(ROOT, 'outbox'),
  artifactsDir: path.join(ROOT, 'artifacts'),
  stateDir: path.join(ROOT, 'state'),
  logsDir: path.join(ROOT, 'state', 'logs'),
  proposalsDir: path.join(ROOT, 'state', 'proposals'),
  dbPath: path.join(ROOT, 'state', 'icarus.db'),
  shutdownMarker: path.join(ROOT, 'state', '.clean-shutdown'),

  // Paths Claude sessions must never write (guard.ts). Compared case-insensitively.
  protectedPaths: [
    path.join(DESKTOP, 'CLAUDE.md'),
    path.join(DESKTOP, 'wiki', 'CLAUDE.md'),
    path.join(process.env.USERPROFILE ?? 'C:\\Users\\jeon', '.claude'),
  ],

  hardCapMs: 30 * 60_000,
  reflectionCapMs: 45 * 60_000,
  idleCapMs: 10 * 60_000,
};

export const OWNER_JID = 'dm:owner';
export const REFLECTION_JOB = 'reflection';
export const MEMORY_JOB = 'memory-consolidation';
