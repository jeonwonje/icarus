import { readFileSync } from 'node:fs';
import path from 'node:path';

export interface WikiProject {
  slug: string;
  title: string; // first meaningful line after heading, else slug
}

const HEADING = /^###\s+\[([a-z0-9-]+)\]\(\1\/index\.md\)\s*$/i;

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 4); // distinctive multi-character tokens
}

export function listWikiProjects(wikiDir: string): WikiProject[] {
  let index: string;
  try {
    index = readFileSync(path.join(wikiDir, 'index.md'), 'utf8');
  } catch {
    return [];
  }
  const lines = index.split(/\r?\n/);
  const out: WikiProject[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(HEADING);
    if (!m) continue;
    const slug = m[1].toLowerCase();
    let title = slug;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j].trim();
      if (!line) continue;
      if (line.startsWith('#')) break;
      title = line.replace(/\*\*/g, '').slice(0, 120);
      break;
    }
    out.push({ slug, title });
  }
  return out;
}
