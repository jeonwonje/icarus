import fs from 'fs';
import path from 'path';

import { indexFile, skillsDir } from './scaffold.js';
import { readLogTail } from './log.js';

function readIfExists(file: string): string {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8').trim() : '';
}

function listSkills(): string {
  const dir = skillsDir();
  if (!fs.existsSync(dir)) return '';
  const lines: string[] = [];
  const files = fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => e.name)
    .sort();
  for (const name of files) {
    let title = '';
    try {
      const content = fs.readFileSync(path.join(dir, name), 'utf-8');
      const first = content.split('\n').find((l) => l.trim().length > 0) ?? '';
      title = first.replace(/^#+\s*/, '').trim();
    } catch {
      /* unreadable; fall through */
    }
    lines.push(title ? `skills/${name} — ${title}` : `skills/${name}`);
  }
  return lines.join('\n');
}

/**
 * Build the prompt prefix: wiki index, recent log tail, and the global
 * skills catalog. Used at the top of every agent turn.
 */
export function buildBootstrapPrefix(): string {
  const index = readIfExists(indexFile());
  const logTail = readLogTail(20);
  const skills = listSkills();

  const parts: string[] = [];
  if (index) parts.push(`<wiki_index>\n${index}\n</wiki_index>`);
  if (logTail) parts.push(`<recent_activity>\n${logTail}\n</recent_activity>`);
  if (skills) parts.push(`<skills>\n${skills}\n</skills>`);

  return parts.length ? parts.join('\n\n') + '\n\n' : '';
}
