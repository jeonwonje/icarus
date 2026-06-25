import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, HUB_DIR, PROJECT_ROOT } from '../core/config.js';
import { logger } from '../core/logger.js';

export function hubDir(): string {
  return HUB_DIR;
}
export function rawDir(): string {
  return path.join(HUB_DIR, 'raw');
}
export function rawCanvasDir(): string {
  return path.join(rawDir(), 'canvas');
}
export function rawOutlookDir(): string {
  return path.join(rawDir(), 'outlook');
}
export function wikiDir(): string {
  return path.join(HUB_DIR, 'wiki');
}
export function outboxDir(): string {
  return path.join(HUB_DIR, 'outbox');
}
export function channelOutboxDir(channel: string): string {
  return path.join(outboxDir(), channel.replace(/[^A-Za-z0-9._-]/g, '_'));
}
export function claudeDir(): string {
  return path.join(HUB_DIR, '.claude');
}
export function skillsDir(): string {
  return path.join(claudeDir(), 'skills');
}

/** Recursively copy a directory tree (overwriting files at the destination). */
function copyDir(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

function writeIfMissing(file: string, content: string): boolean {
  if (fs.existsSync(file)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return true;
}

function renderClaudeMd(): string {
  return `# ${ASSISTANT_NAME}

You are ${ASSISTANT_NAME}, the knowledge agent for this hub. The hub folder (your
working directory) is your persistent memory — everything important must live
here, not just in chat.

## Memory schema

- \`raw/\` — the single source of truth. Read-only mirrors of real sources.
  - \`raw/canvas/\` — Canvas course material (written by the canvas-ingest skill).
  - \`raw/outlook/\` — mail + attachments parsed from the daily .pst export (outlook-ingest skill).
  - Loose files dropped at the \`raw/\` root are unfiled Telegram attachments — file them.
- \`wiki/\` — your own markdown notes: entity pages, concept pages, summaries. DERIVED from raw/.
- \`index.md\` — one-line-per-page catalog of \`wiki/\`, grouped by category.
- \`log.md\` — append-only activity log. One terse \`YYYY-MM-DD HH:MM — summary\` line per turn.
- \`outbox/\` — drop files in the per-turn path shown in \`<outbox>\` to deliver them to *this* channel.
- \`.claude/skills/\` — skills you can invoke (document skills + ingest skills).

## Grounding (HARD RULE — no hallucination)

- \`raw/\` is authoritative. \`wiki/\` and \`index.md\` are derived and regenerable from \`raw/\`; if they ever disagree, \`raw/\` wins.
- Every substantive answer must cite the specific hub file(s) it is grounded on.
- If the answer is not in the hub, say so plainly and offer to ingest the relevant source
  (e.g. "I don't have that — want me to pull the latest Canvas?"). Never invent an answer.

## Documents

- For \`.docx\`, \`.pdf\`, \`.xlsx\`, \`.pptx\` use the matching skill in \`.claude/skills/\`.
- For images, read them directly with your vision — do NOT shell out to an OCR tool.

## Ingest (on demand only)

- To refresh Canvas: invoke the \`canvas-ingest\` skill (it runs \`node $ICARUS_HOME/dist/ingest/canvas.js\`).
- To refresh Outlook: invoke the \`outlook-ingest\` skill (it runs \`node $ICARUS_HOME/dist/ingest/outlook.js\`).
- After an ingest, new files appear under \`raw/\`; file them into \`wiki/\` and update \`index.md\`.

## Channels

You serve three isolated channels — personal, academic, work — each with its own
persistent session. Keep their contexts separate.

## Rules

- Never edit files outside this hub.
- Keep \`index.md\` in sync with \`wiki/\`.
- Append one terse line to \`log.md\` at the end of each turn.
- Prefer many small wiki pages over a few large ones.
`;
}

function renderSettingsJson(): string {
  return (
    JSON.stringify(
      {
        permissions: { defaultMode: 'bypassPermissions' },
        mcpServers: {},
      },
      null,
      2,
    ) + '\n'
  );
}

/**
 * Idempotently scaffold the hub skeleton and refresh vendored skills.
 * Returns true if anything was created/refreshed this run.
 */
export function ensureHubLayout(): boolean {
  fs.mkdirSync(rawCanvasDir(), { recursive: true });
  fs.mkdirSync(rawOutlookDir(), { recursive: true });
  fs.mkdirSync(wikiDir(), { recursive: true });
  fs.mkdirSync(skillsDir(), { recursive: true });

  let created = false;

  // Refresh vendored skills from the repo's version-controlled source.
  const repoSkills = path.join(PROJECT_ROOT, 'skills');
  if (fs.existsSync(repoSkills)) {
    copyDir(repoSkills, skillsDir());
    created = true;
  }

  created = writeIfMissing(path.join(HUB_DIR, 'CLAUDE.md'), renderClaudeMd()) || created;
  created =
    writeIfMissing(path.join(claudeDir(), 'settings.json'), renderSettingsJson()) || created;
  created =
    writeIfMissing(
      path.join(HUB_DIR, 'index.md'),
      '# Wiki index\n\nNo pages yet. List wiki/ pages here, one line each, grouped by category.\n',
    ) || created;
  created =
    writeIfMissing(
      path.join(HUB_DIR, 'log.md'),
      `# Activity log\n\n${new Date().toISOString()} — hub scaffolded.\n`,
    ) || created;

  if (created) logger.info({ dir: HUB_DIR }, 'hub layout scaffolded');
  return created;
}
