import { InlineKeyboard } from 'grammy';
import { clip, refFor, type Rendered } from '../../telegram/ui.js';
import type { ArchiveHit, ArchiveWindow } from './archiveQuery.js';

const hitRef = (peerKey: string, messageId: number): number =>
  refFor(JSON.stringify({ peerKey, messageId }));

const queryRef = (query: string): number => refFor(query);

export function renderArchiveSearch(query: string, hits: ArchiveHit[]): Rendered {
  if (hits.length === 0) {
    return {
      text: `archive search: ${clip(query, 80)}\n\nno matches`,
      keyboard: new InlineKeyboard(),
    };
  }
  const lines = [`archive search: ${clip(query, 80)}`, ''];
  const kb = new InlineKeyboard();
  hits.forEach((h, i) => {
    const who = h.senderName ?? 'unknown';
    lines.push(`${i + 1}. [${clip(h.chatTitle, 40)}] ${who} · ${h.sentAt.slice(0, 16)}`);
    lines.push(`   ${clip(h.snippet, 120)}`);
    kb.text(`#${i + 1} open`, `ar:w:${hitRef(h.peerKey, h.messageId)}:${queryRef(query)}`).row();
  });
  return { text: lines.join('\n'), keyboard: kb };
}

export function renderArchiveWindow(query: string, win: ArchiveWindow): Rendered {
  const lines = [`archive window · ${clip(win.anchor.chatTitle, 40)}`, ''];
  for (const m of win.messages) {
    const mark = m.messageId === win.anchor.messageId ? '▸' : '·';
    const who = m.senderName ?? 'unknown';
    lines.push(`${mark} ${who} · ${m.sentAt.slice(0, 16)}`);
    if (m.deepLink) lines.push(`  ${m.deepLink}`);
    lines.push(`  ${clip(m.text, 280)}`);
  }
  const kb = new InlineKeyboard().text('« search', `ar:s:${queryRef(query)}`);
  if (win.anchor.hasMedia) {
    kb
      .row()
      .text(
        '📥 ingest media',
        `ar:ing:${hitRef(win.anchor.peerKey, win.anchor.messageId)}:${queryRef(query)}`,
      );
  }
  return { text: lines.join('\n'), keyboard: kb };
}

export function renderArchiveUnavailable(): Rendered {
  return {
    text: 'archive unavailable — personal Telegram is not configured or not started. Use /tg after tg-setup.',
    keyboard: new InlineKeyboard(),
  };
}
