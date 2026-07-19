import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const MEMORY_CAP = 4_096;

const DEFAULT_INDEX = `# Memory index

One line per durable fact, grouped under short topic headers. Detail lives in topic
files beside this one (people.md, preferences.md, per-project notes) — this file is
injected into every turn, so keep it small and keep it an index.
`;

export function scaffoldMemory(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const index = path.join(dir, 'MEMORY.md');
  if (!existsSync(index)) writeFileSync(index, DEFAULT_INDEX);
}

/** MEMORY.md as an injectable block, capped so a bloated index can't flood every turn. */
export function buildMemoryBlock(dir: string): string | null {
  let text: string;
  try {
    text = readFileSync(path.join(dir, 'MEMORY.md'), 'utf8').trim();
  } catch {
    return null;
  }
  if (!text) return null;
  const capped =
    text.length <= MEMORY_CAP
      ? text
      : text.slice(0, MEMORY_CAP) +
        `\n[truncated — MEMORY.md exceeds ${MEMORY_CAP} chars; consolidate detail into topic files]`;
  return `<memory dir="${dir}">\n${capped}\n</memory>`;
}
