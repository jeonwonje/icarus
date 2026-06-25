import fs from 'fs';
import path from 'path';
import { hubDir } from './scaffold.js';

function logPath(): string {
  return path.join(hubDir(), 'log.md');
}

export function appendLogEntry(summary: string): void {
  const clean = summary.slice(0, 180).replace(/\s+/g, ' ').trim();
  if (!clean) return;
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  fs.appendFileSync(logPath(), `${stamp} — ${clean}\n`);
}

export function readLogTail(n: number): string {
  try {
    const lines = fs.readFileSync(logPath(), 'utf-8').trimEnd().split('\n');
    return lines.slice(-n).join('\n');
  } catch {
    return '';
  }
}
