import type { TelegramArchiveStore } from './archiveStore.js';
import type { TelegramPeerKind } from './types.js';

export const SEARCH_DEFAULT_LIMIT = 10;
export const SEARCH_MAX_LIMIT = 25;
export const WINDOW_DEFAULT_RADIUS = 5;
export const WINDOW_MAX_RADIUS = 15;
export const SNIPPET_MAX = 240;
export const WINDOW_TEXT_MAX = 2000;

export interface ArchiveHit {
  peerKey: string;
  messageId: number;
  chatTitle: string;
  senderKey?: string;
  senderName?: string;
  sentAt: string;
  editedAt?: string;
  deleted: boolean;
  deletedAt?: string;
  snippet: string;
  deepLink?: string;
  hasMedia: boolean;
  hasLinks: boolean;
}

export interface ArchiveWindowMessage {
  peerKey: string;
  messageId: number;
  chatTitle: string;
  senderKey?: string;
  senderName?: string;
  sentAt: string;
  editedAt?: string;
  deleted: boolean;
  deletedAt?: string;
  text: string;
  deepLink?: string;
  hasMedia: boolean;
  hasLinks: boolean;
}

export interface ArchiveWindow {
  anchor: ArchiveWindowMessage;
  messages: ArchiveWindowMessage[];
}

/** Quote each token for FTS5 so user operators cannot break or broaden the query. */
export function escapeFtsQuery(raw: string): string {
  const tokens = raw
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/"/g, '""'))
    .filter(Boolean);
  if (tokens.length === 0) throw new Error('empty query');
  return tokens.map((t) => `"${t}"`).join(' ');
}

export function clampInt(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || Number.isNaN(value)) return fallback;
  return Math.max(0, Math.min(Math.floor(value), max));
}

export function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…[truncated]`;
}

export function deepLinkFor(input: {
  kind: TelegramPeerKind;
  username?: string;
  peerKey: string;
  messageId: number;
}): string | undefined {
  if (input.username) return `https://t.me/${input.username}/${input.messageId}`;
  if (input.kind === 'supergroup') {
    const id = input.peerKey.slice(input.peerKey.indexOf(':') + 1);
    if (/^\d+$/.test(id)) return `https://t.me/c/${id}/${input.messageId}`;
  }
  return undefined;
}

export class TelegramArchiveQuery {
  constructor(private readonly store: TelegramArchiveStore) {}

  search(input: {
    query: string;
    peerKey?: string;
    includeDeleted?: boolean;
    limit?: number;
  }): ArchiveHit[] {
    const match = escapeFtsQuery(input.query);
    const limit = clampInt(input.limit, SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT) || SEARCH_DEFAULT_LIMIT;
    const includeDeleted = !!input.includeDeleted;
    const rows = this.store.searchFts({
      match,
      peerKey: input.peerKey,
      includeDeleted,
      limit,
    });
    return rows.map((r) => ({
      peerKey: r.peerKey,
      messageId: r.messageId,
      chatTitle: r.chatTitle,
      senderKey: r.senderKey,
      senderName: r.senderName,
      sentAt: r.sentAt,
      editedAt: r.editedAt,
      deleted: !!r.deletedAt,
      deletedAt: r.deletedAt,
      snippet: clipText(r.text, SNIPPET_MAX),
      deepLink: deepLinkFor({
        kind: r.chatKind,
        username: r.chatUsername,
        peerKey: r.peerKey,
        messageId: r.messageId,
      }),
      hasMedia: this.store.messageHasMedia(r.peerKey, r.messageId),
      hasLinks: this.store.messageHasLinks(r.peerKey, r.messageId),
    }));
  }

  window(input: {
    peerKey: string;
    messageId: number;
    before?: number;
    after?: number;
    includeDeleted?: boolean;
  }): ArchiveWindow {
    const before = clampInt(input.before, WINDOW_DEFAULT_RADIUS, WINDOW_MAX_RADIUS);
    const after = clampInt(input.after, WINDOW_DEFAULT_RADIUS, WINDOW_MAX_RADIUS);
    const includeDeleted = !!input.includeDeleted;
    if (!this.store.isSelected(input.peerKey)) throw new Error('chat not found or not selected');
    const rows = this.store.loadMessageWindow({
      peerKey: input.peerKey,
      messageId: input.messageId,
      before,
      after,
      includeDeleted,
    });
    if (rows.length === 0) throw new Error('message not found');
    const messages = rows.map((r) => ({
      peerKey: r.peerKey,
      messageId: r.messageId,
      chatTitle: r.chatTitle,
      senderKey: r.senderKey,
      senderName: r.senderName,
      sentAt: r.sentAt,
      editedAt: r.editedAt,
      deleted: !!r.deletedAt,
      deletedAt: r.deletedAt,
      text: clipText(r.text, WINDOW_TEXT_MAX),
      deepLink: deepLinkFor({
        kind: r.chatKind,
        username: r.chatUsername,
        peerKey: r.peerKey,
        messageId: r.messageId,
      }),
      hasMedia: this.store.messageHasMedia(r.peerKey, r.messageId),
      hasLinks: this.store.messageHasLinks(r.peerKey, r.messageId),
    }));
    const anchor = messages.find((m) => m.messageId === input.messageId);
    if (!anchor) throw new Error('message not found');
    if (!includeDeleted && anchor.deleted) throw new Error('message not found');
    return { anchor, messages };
  }
}

export function formatHitLines(hits: ArchiveHit[]): string {
  if (hits.length === 0) return 'no matches';
  return hits
    .map((h, i) => {
      const who = h.senderName ?? h.senderKey ?? 'unknown';
      const link = h.deepLink ?? `${h.peerKey}#${h.messageId}`;
      const del = h.deleted ? ' · deleted' : '';
      return `${i + 1}. [${h.chatTitle}] ${who} · ${h.sentAt}${del}\n   ${link}\n   ${h.snippet}`;
    })
    .join('\n');
}

export function formatWindow(win: ArchiveWindow): string {
  const lines = win.messages.map((m) => {
    const who = m.senderName ?? m.senderKey ?? 'unknown';
    const link = m.deepLink ?? `${m.peerKey}#${m.messageId}`;
    const mark = m.messageId === win.anchor.messageId ? '▸' : '·';
    const del = m.deleted ? ' · deleted' : '';
    return `${mark} [${m.chatTitle}] ${who} · ${m.sentAt}${del}\n  ${link}\n  ${m.text}`;
  });
  return lines.join('\n');
}
