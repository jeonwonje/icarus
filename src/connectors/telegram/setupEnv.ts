import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { TelegramConfigState } from './types.js';

export interface TelegramEnvValues {
  apiId?: number;
  apiHash?: string;
  session?: string;
}

export function telegramConfigState(values: TelegramEnvValues): TelegramConfigState {
  const present = [values.apiId, values.apiHash, values.session].filter(
    (value) => value !== undefined && value !== '',
  ).length;
  return present === 0 ? 'not_configured' : present === 3 ? 'configured' : 'partial';
}

export function upsertTelegramEnv(source: string, complete: Required<TelegramEnvValues>): string {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const replacements: Record<string, string> = {
    TG_API_ID: String(complete.apiId),
    TG_API_HASH: complete.apiHash,
    TG_SESSION: complete.session,
  };
  const seen = new Set<string>();
  const lines = source.length === 0 ? [] : source.replace(/\r?\n$/, '').split(/\r?\n/);
  const output: string[] = [];
  for (const line of lines) {
    const match = line.match(/^\s*(TG_API_ID|TG_API_HASH|TG_SESSION)=/);
    if (!match) {
      output.push(line);
      continue;
    }
    if (seen.has(match[1])) continue;
    seen.add(match[1]);
    output.push(`${match[1]}=${replacements[match[1]]}`);
  }
  for (const key of ['TG_API_ID', 'TG_API_HASH', 'TG_SESSION']) {
    if (!seen.has(key)) output.push(`${key}=${replacements[key]}`);
  }
  return output.join(newline) + newline;
}

export function writeTelegramEnvAtomic(
  envPath: string,
  complete: Required<TelegramEnvValues>,
): void {
  const source = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  const tempPath = path.join(path.dirname(envPath), `.${path.basename(envPath)}.tg-setup.tmp`);
  writeFileSync(tempPath, upsertTelegramEnv(source, complete), { encoding: 'utf8', flush: true });
  renameSync(tempPath, envPath);
}
