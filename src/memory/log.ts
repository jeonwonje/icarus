import fs from 'fs';

import { threadLogFile } from './threads.js';

function stamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export function appendLogEntry(threadJid: string, summary: string, tag?: string): void {
  const file = threadLogFile(threadJid);
  if (!fs.existsSync(file)) return;
  const prefix = tag ? `[${tag}] ` : '';
  const line = `${stamp()} — ${prefix}${summary.replace(/\s+/g, ' ').slice(0, 300)}\n`;
  fs.appendFileSync(file, line);
}

export function readLogTail(threadJid: string, lines = 20): string {
  const file = threadLogFile(threadJid);
  if (!fs.existsSync(file)) return '';
  const content = fs.readFileSync(file, 'utf-8');
  const split = content.trimEnd().split('\n');
  return split.slice(-lines).join('\n');
}
