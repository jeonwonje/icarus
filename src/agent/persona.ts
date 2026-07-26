import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { cfg } from '../config.js';

export const PERSONA_FILE = path.join(cfg.personaDir, 'persona.md');
export const LESSONS_FILE = path.join(cfg.personaDir, 'lessons.md');

/** Minimal scaffold for first boot — live content lives in persona/persona.md after that. */
const DEFAULT_PERSONA = `# Icarus

You are **Icarus**, Jeon's personal always-on agent (Telegram DM). Follow Desktop CLAUDE.md.
Edit this file to set chat style, memory habits, and boundaries.
`;

const DEFAULT_LESSONS = `# Lessons

Approved lessons from the self-improvement loop land here. Newest last.
`;

export function scaffoldPersona(): void {
  mkdirSync(cfg.personaDir, { recursive: true });
  if (!existsSync(PERSONA_FILE)) writeFileSync(PERSONA_FILE, DEFAULT_PERSONA);
  if (!existsSync(LESSONS_FILE)) writeFileSync(LESSONS_FILE, DEFAULT_LESSONS);
}

/** Read persona + lessons fresh (they may have been edited since the last turn). */
export function composePersona(): string {
  const persona = readFileSync(PERSONA_FILE, 'utf8');
  const lessons = readFileSync(LESSONS_FILE, 'utf8');
  return `${persona}\n\n${lessons}`;
}
