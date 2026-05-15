import fs from 'fs';
import path from 'path';

import { skillsDir } from './scaffold.js';
import { readLogTail } from './log.js';
import { threadIndexFile } from './threads.js';

function readIfExists(file: string): string {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8').trim() : '';
}

/**
 * List skills as `skills/<name>.md — <h1 title>`. The h1 (or first non-blank
 * line) doubles as the description so the agent can decide whether to open
 * the file. Skills live as single .md files under data/skills/ (global).
 */
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
      // Unreadable; fall through with empty title.
    }
    lines.push(title ? `skills/${name} — ${title}` : `skills/${name}`);
  }
  return lines.join('\n');
}

/**
 * Build the prompt prefix for a per-thread turn: this thread's wiki index,
 * its recent activity log, and the global skills catalog.
 */
export function buildBootstrapPrefix(threadJid: string): string {
  const index = readIfExists(threadIndexFile(threadJid));
  const logTail = readLogTail(threadJid, 20);
  const skills = listSkills();

  const parts: string[] = [];
  if (index) parts.push(`<wiki_index>\n${index}\n</wiki_index>`);
  if (logTail) parts.push(`<recent_activity>\n${logTail}\n</recent_activity>`);
  if (skills) parts.push(`<skills>\n${skills}\n</skills>`);

  return parts.length ? parts.join('\n\n') + '\n\n' : '';
}
