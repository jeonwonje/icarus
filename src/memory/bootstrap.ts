import fs from 'fs';
import path from 'path';

import { indexFile, logFile, rawDir, skillsDir } from './scaffold.js';
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
 * Top-level files under raw/ with mtime newer than log.md (minus a 60s skew
 * margin) — i.e. sources dropped since the last logged turn. Newly-arrived
 * files sit at the raw/ root; once the agent files them into a topic folder
 * they become nested and stop surfacing here.
 */
function listNewSources(): string[] {
  const dir = rawDir();
  if (!fs.existsSync(dir)) return [];
  const log = logFile();
  const logMtime = fs.existsSync(log) ? fs.statSync(log).mtimeMs : 0;
  const fresh: string[] = [];
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    try {
      const stat = fs.statSync(full);
      if (stat.isFile() && stat.mtimeMs > logMtime - 60_000) {
        fresh.push(`raw/${entry}`);
      }
    } catch {
      // Dangling symlink or transient fs error — skip.
    }
  }
  return fresh;
}

/**
 * 2-level directory listing under raw/ so the agent can file new sources into
 * an existing topic folder instead of inventing duplicates. Second-level
 * listing is capped per folder to keep the prefix cheap.
 */
function listRawTree(): string {
  const dir = rawDir();
  if (!fs.existsSync(dir)) return '';
  const lines: string[] = [];
  const top = fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() || e.isSymbolicLink())
    .map((e) => e.name)
    .filter((n) => !n.startsWith('.'))
    .sort();
  for (const name of top) {
    lines.push(`raw/${name}/`);
    const sub = path.join(dir, name);
    try {
      const children = fs.readdirSync(sub, { withFileTypes: true })
        .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith('.'))
        .map((e) => e.name)
        .sort();
      const shown = children.slice(0, 12);
      for (const c of shown) lines.push(`  raw/${name}/${c}/`);
      if (children.length > shown.length) {
        lines.push(`  ... ${children.length - shown.length} more`);
      }
    } catch {
      // Dangling or unreadable; skip.
    }
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
  const rawTree = listRawTree();
  const newSources = listNewSources();

  const parts: string[] = [];
  if (index) parts.push(`<wiki_index>\n${index}\n</wiki_index>`);
  if (logTail) parts.push(`<recent_activity>\n${logTail}\n</recent_activity>`);
  if (skills) parts.push(`<skills>\n${skills}\n</skills>`);
  if (rawTree) parts.push(`<raw_folders>\n${rawTree}\n</raw_folders>`);
  if (newSources.length)
    parts.push(`<new_sources>\n${newSources.join('\n')}\n</new_sources>`);

  return parts.length ? parts.join('\n\n') + '\n\n' : '';
}
