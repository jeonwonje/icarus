import fs from 'fs';
import path from 'path';

import { hubDir, rawDir, channelOutboxDir } from '../memory/scaffold.js';
import { readLogTail } from '../memory/log.js';
import type { TurnMeta } from './types.js';

/** Files at the raw/ root that are NOT inbox arrivals. Subdirs are skipped too. */
const INBOX_KEEP = new Set(['TOPIC_GUIDE.md', 'NAMING_CONVENTION.md']);

/**
 * The raw/ root is the inbox. Surface EVERY loose FILE sitting there (not the
 * canvas/ and outlook/ subdirs, which are ingest mirrors) so the agent files
 * it. mtime-blind and self-healing: a file stays flagged every turn until it
 * is filed out of the root, so an attachment can never be silently orphaned.
 */
function listNewSources(): string[] {
  const dir = rawDir();
  if (!fs.existsSync(dir)) return [];
  const inbox: string[] = [];
  for (const entry of fs.readdirSync(dir)) {
    if (INBOX_KEEP.has(entry)) continue;
    try {
      if (fs.statSync(path.join(dir, entry)).isFile()) inbox.push(`raw/${entry}`);
    } catch {
      /* dangling */
    }
  }
  return inbox;
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function buildTurnContext(channel: string, meta?: TurnMeta): string {
  const abs = channelOutboxDir(channel);
  fs.mkdirSync(abs, { recursive: true });
  const outboxRel = path.relative(hubDir(), abs).split(path.sep).join('/') + '/';

  const parts: string[] = [`<outbox>\n${outboxRel}\n</outbox>`];
  const logTail = readLogTail(10);
  if (logTail) parts.push(`<recent_activity>\n${logTail}\n</recent_activity>`);
  const newSources = listNewSources();
  if (newSources.length) parts.push(`<new_sources>\n${newSources.join('\n')}\n</new_sources>`);
  if (meta) {
    parts.push(
      `<turn_meta channel="${escapeAttr(meta.channel)}" ` +
        `sender_id="${escapeAttr(meta.senderId)}" ` +
        `sender_name="${escapeAttr(meta.senderName ?? '')}"/>`,
    );
  }
  return parts.join('\n\n');
}

/** SDK hook: inject buildTurnContext as additionalContext on UserPromptSubmit. */
export function userPromptSubmitHook(channel: string, meta?: TurnMeta) {
  return [
    {
      hooks: [
        async () => ({
          hookSpecificOutput: {
            hookEventName: 'UserPromptSubmit' as const,
            additionalContext: buildTurnContext(channel, meta),
          },
        }),
      ],
    },
  ];
}
