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

function trailingEnvComment(valueAndSuffix: string): string {
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < valueAndSuffix.length; index += 1) {
    const char = valueAndSuffix[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '#') {
      let commentStart = index;
      while (commentStart > 0 && /\s/.test(valueAndSuffix[commentStart - 1])) {
        commentStart -= 1;
      }
      return valueAndSuffix.slice(commentStart);
    }
  }
  return '';
}

export function upsertTelegramEnv(source: string, complete: Required<TelegramEnvValues>): string {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const hasTerminalNewline = /\r?\n$/.test(source);
  const replacements: Record<string, string> = {
    TG_API_ID: String(complete.apiId),
    TG_API_HASH: complete.apiHash,
    TG_SESSION: complete.session,
  };
  const seen = new Set<string>();
  const lines = source.length === 0 ? [] : source.replace(/\r?\n$/, '').split(/\r?\n/);
  const output: string[] = [];
  for (const line of lines) {
    const match = line.match(/^(\s*(TG_API_ID|TG_API_HASH|TG_SESSION)\s*=\s*)(.*)$/);
    if (!match) {
      output.push(line);
      continue;
    }
    const [, assignment, key, valueAndSuffix] = match;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(`${assignment}${replacements[key]}${trailingEnvComment(valueAndSuffix)}`);
  }
  for (const key of ['TG_API_ID', 'TG_API_HASH', 'TG_SESSION']) {
    if (!seen.has(key)) output.push(`${key}=${replacements[key]}`);
  }
  return output.join(newline) + (hasTerminalNewline ? newline : '');
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
