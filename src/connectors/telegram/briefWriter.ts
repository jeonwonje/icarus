import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { clipText, type TelegramArchiveQuery } from './archiveQuery.js';
import type { TelegramArchiveStore } from './archiveStore.js';
import type { TelegramProjectStore } from './projectStore.js';

export interface BriefNote {
  claim: string;
  sender: string;
  sentAt: string;
  link: string;
}

export function chatSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
    .replace(/-$/, '');
}

export function isLowSignal(text: string): boolean {
  const t = text.trim();
  if (t.length < 24) return true;
  const tokens = t.match(/[a-zA-Z0-9]{3,}/g) ?? [];
  if (tokens.length < 3) return true;
  const alnum = (t.match(/[a-zA-Z0-9]/g) ?? []).length;
  if (t.length > 0 && alnum / t.length < 0.3) return true;
  return false;
}

function assertSafeWikiPath(wikiDir: string, relPath: string): string {
  const segments = relPath.split(/[/\\]/);
  if (segments.some((s) => s === '..' || s === '')) throw new Error('invalid wiki path');
  const resolvedWiki = path.resolve(wikiDir);
  const full = path.resolve(wikiDir, relPath);
  if (full !== resolvedWiki && !full.startsWith(resolvedWiki + path.sep)) {
    throw new Error('path outside wiki root');
  }
  return full;
}

export function upsertMemoryPointer(
  memoryDir: string,
  wikiProject: string,
  displayTitle: string,
): void {
  const memoryPath = path.join(memoryDir, 'MEMORY.md');
  const line = `- **${displayTitle}** — Telegram project brief: wiki/${wikiProject}/`;
  const content = existsSync(memoryPath)
    ? readFileSync(memoryPath, 'utf8')
    : '# Memory index\n\n';
  const needle = `wiki/${wikiProject}/`;
  const lines = content.split('\n').filter((l) => !l.includes(needle));
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
  lines.push(line, '');
  writeFileSync(memoryPath, lines.join('\n'));
}

function collectNotes(input: {
  query: TelegramArchiveQuery;
  archive: TelegramArchiveStore;
  peerKey: string;
  wikiProject: string;
}): BriefNote[] {
  const searchQuery = input.wikiProject.replace(/-/g, ' ');
  let hits = [] as ReturnType<TelegramArchiveQuery['search']>;
  try {
    hits = input.query.search({ query: searchQuery, peerKey: input.peerKey, limit: 8 });
  } catch {
    hits = [];
  }
  let notes = hits
    .filter((h) => !isLowSignal(h.snippet))
    .slice(0, 5)
    .map((h) => ({
      claim: clipText(h.snippet, 200),
      sender: h.senderName ?? h.senderKey ?? 'unknown',
      sentAt: h.sentAt,
      link: h.deepLink ?? `${h.peerKey}#${h.messageId}`,
    }));

  if (notes.length === 0) {
    const newestId = input.archive.newestMessageId(input.peerKey);
    if (newestId !== undefined) {
      try {
        const win = input.query.window({
          peerKey: input.peerKey,
          messageId: newestId,
          before: 10,
          after: 0,
        });
        notes = win.messages
          .filter((m) => !isLowSignal(m.text))
          .slice(0, 5)
          .map((m) => ({
            claim: clipText(m.text, 200),
            sender: m.senderName ?? m.senderKey ?? 'unknown',
            sentAt: m.sentAt,
            link: m.deepLink ?? `${m.peerKey}#${m.messageId}`,
          }));
      } catch {
        notes = [];
      }
    }
  }
  return notes;
}

function renderBriefMarkdown(
  chatTitle: string,
  peerKey: string,
  briefRel: string,
  notes: BriefNote[],
): string {
  const lines = [
    `# Telegram brief — ${chatTitle}`,
    '',
    `Mapped from selected Telegram chat \`${peerKey}\`. Claims cite archive messages (retrievable).`,
    `Locator: \`${briefRel}\``,
    '',
    '## Notes',
  ];
  if (notes.length === 0) {
    lines.push(
      `- No high-signal samples yet for \`${peerKey}\` (${chatTitle}). Mapping is recorded; re-run approval after more archive content arrives.`,
    );
  } else {
    for (const n of notes) {
      lines.push(`- ${n.claim} — ${n.sender}, ${n.sentAt}, ${n.link}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

export function writeBriefAndMemory(input: {
  wikiDir: string;
  memoryDir: string;
  wikiProject: string;
  chatTitle: string;
  peerKey: string;
  query: TelegramArchiveQuery;
  archive: TelegramArchiveStore;
}): { briefPath: string } {
  const slug = chatSlug(input.chatTitle);
  const briefRel = `${input.wikiProject}/telegram-${slug}.md`;
  const briefFull = assertSafeWikiPath(input.wikiDir, briefRel);
  const notes = collectNotes({
    query: input.query,
    archive: input.archive,
    peerKey: input.peerKey,
    wikiProject: input.wikiProject,
  });
  const markdown = renderBriefMarkdown(input.chatTitle, input.peerKey, briefRel, notes);
  mkdirSync(path.dirname(briefFull), { recursive: true });
  writeFileSync(briefFull, markdown, 'utf8');
  upsertMemoryPointer(input.memoryDir, input.wikiProject, input.chatTitle);
  return { briefPath: briefRel };
}

export interface AppendFact {
  claim: string;
  cites: string[];
}

/** Append fact bullets under ## Notes (creates section if missing). Returns count appended. */
export function appendFactsToBrief(
  wikiDir: string,
  briefRel: string,
  facts: AppendFact[],
): number {
  if (facts.length === 0) return 0;
  const briefFull = assertSafeWikiPath(wikiDir, briefRel);
  if (!existsSync(briefFull)) throw new Error(`brief not found: ${briefRel}`);

  const bullets = facts.map((f) => {
    const citePart = f.cites.join(', ');
    return `- ${f.claim} — ${citePart}`;
  });

  let content = readFileSync(briefFull, 'utf8');
  const notesHeader = '## Notes';
  const idx = content.indexOf(notesHeader);

  if (idx >= 0) {
    const afterHeader = idx + notesHeader.length;
    const rest = content.slice(afterHeader);
    const nextSection = rest.search(/\n## /);
    if (nextSection >= 0) {
      const insertPos = afterHeader + nextSection;
      content =
        content.slice(0, insertPos).replace(/\s*$/, '') +
        '\n' +
        bullets.join('\n') +
        content.slice(insertPos);
    } else {
      content = content.trimEnd() + '\n' + bullets.join('\n') + '\n';
    }
  } else {
    content = content.trimEnd() + '\n\n' + notesHeader + '\n' + bullets.join('\n') + '\n';
  }

  writeFileSync(briefFull, content, 'utf8');
  return facts.length;
}

export function applyApproval(input: {
  proposalId: number;
  projects: TelegramProjectStore;
  query: TelegramArchiveQuery;
  archive: TelegramArchiveStore;
  wikiDir: string;
  memoryDir: string;
}): { briefPath: string } {
  const proposal = input.projects.getProposal(input.proposalId);
  if (!proposal || proposal.state !== 'pending') throw new Error('proposal not pending');
  const chat = input.archive.getChat(proposal.peerKey);
  if (!chat) throw new Error('chat not found');

  const slug = chatSlug(chat.title);
  const briefRel = `${proposal.wikiProject}/telegram-${slug}.md`;
  const briefFull = assertSafeWikiPath(input.wikiDir, briefRel);
  const notes = collectNotes({
    query: input.query,
    archive: input.archive,
    peerKey: proposal.peerKey,
    wikiProject: proposal.wikiProject,
  });
  const markdown = renderBriefMarkdown(chat.title, proposal.peerKey, briefRel, notes);

  mkdirSync(path.dirname(briefFull), { recursive: true });
  writeFileSync(briefFull, markdown, 'utf8');
  upsertMemoryPointer(input.memoryDir, proposal.wikiProject, chat.title);
  try {
    input.projects.approveProposal(input.proposalId, briefRel);
  } catch (error) {
    try {
      unlinkSync(briefFull);
    } catch {
      /* ignore cleanup failure */
    }
    throw error;
  }
  return { briefPath: briefRel };
}
