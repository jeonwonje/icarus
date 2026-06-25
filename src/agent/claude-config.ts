import { readEnvFile } from '../core/env.js';
import { PROJECT_ROOT } from '../core/config.js';

function env(key: string): string | undefined {
  const v = process.env[key];
  if (v && v.trim()) return v.trim();
  const fromFile = readEnvFile([key])[key];
  return fromFile && fromFile.trim() ? fromFile.trim() : undefined;
}

const DEFAULT_MODEL = 'claude-opus-4-8[1m]';

interface ModelOption {
  id: string;
  label: string;
}

function modelOptions(): ModelOption[] {
  return [
    { id: 'claude-opus-4-8[1m]', label: 'Opus 4.8 (1M, default)' },
    { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6 (faster)' },
  ];
}

let modelOverride: string | null = null;

export function getClaudeModel(): string {
  return modelOverride || env('CLAUDE_MODEL') || DEFAULT_MODEL;
}

export function setClaudeModel(id: string | null): void {
  modelOverride = id;
}

export function getModelOptions(): ModelOption[] {
  return modelOptions();
}

/**
 * Required for headless Claude Code (Max/subscription) OAuth. Mint on the host
 * with `claude setup-token` and put it in .env. Throws if absent.
 */
export function requireOAuthToken(): string {
  const t = env('CLAUDE_CODE_OAUTH_TOKEN');
  if (!t) {
    throw new Error(
      'CLAUDE_CODE_OAUTH_TOKEN is not set. Mint one on the host with `claude setup-token` and put it in .env.',
    );
  }
  return t;
}

/**
 * Env for the agent subprocess. The SDK REPLACES process.env with this, so we
 * spread process.env, then add ICARUS_HOME (repo root) so the agent's bash can
 * run the bundled ingest scripts referenced by the ingest skills.
 */
export function buildQueryEnv(): Record<string, string> {
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) e[k] = v;
  e.ICARUS_HOME = PROJECT_ROOT;
  // Ensure the OAuth token reaches the subprocess even if it was only in .env.
  const token = env('CLAUDE_CODE_OAUTH_TOKEN');
  if (token) e.CLAUDE_CODE_OAUTH_TOKEN = token;
  return e;
}
