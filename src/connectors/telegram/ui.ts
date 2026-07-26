import { InlineKeyboard } from 'grammy';
import { clip, refFor, type Rendered } from '../../telegram/ui.js';
import type { TelegramImportRow, TelegramChatRow } from './archiveStore.js';
import type { TelegramDialog, TelegramHealth, TelegramImportState, TelegramPeerKind } from './types.js';

export const TELEGRAM_DIALOG_PAGE_SIZE = 8;

export interface TelegramDialogPageView {
  query: string;
  page: number;
  pageSize: number;
  total: number;
  dialogs: TelegramDialog[];
}

export interface TelegramChatStatusView {
  chat: TelegramChatRow;
  import?: TelegramImportRow;
  downloadedMediaBytes: number;
  failedMedia: number;
  failedLinks: number;
}

const kindIcon = (kind: TelegramPeerKind): string =>
  kind === 'dm' ? '💬' : kind === 'supergroup' ? '🏛' : '👥';

const kindLabel = (kind: TelegramPeerKind): string =>
  kind === 'dm' ? 'dm' : kind === 'supergroup' ? 'supergroup' : 'group';

const importLabel = (state: TelegramImportState): string => {
  switch (state) {
    case 'paused':
      return 'paused';
    case 'scanning':
      return 'scanning history';
    case 'acquiring':
      return 'acquiring media';
    case 'complete':
      return 'complete';
    case 'cancelled':
      return 'cancelled';
    case 'error':
      return 'error';
  }
};

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
};

const formatTs = (iso?: string): string => (iso ? iso.slice(0, 16).replace('T', ' ') : 'never');

const healthStateLabel = (state: TelegramHealth['state']): string => {
  switch (state) {
    case 'not_configured':
      return 'not configured';
    case 'partial_config':
      return 'partial config';
    case 'connecting':
      return 'connecting';
    case 'connected':
      return 'connected';
    case 'temporarily_offline':
      return 'temporarily offline';
    case 'authorization_failed':
      return 'authorization failed';
  }
};

const queryRef = (query: string): number => refFor(query);

const peerRef = (peerKey: string): number => refFor(peerKey);

export function renderTelegramStatusLine(health: TelegramHealth): string {
  const parts = [healthStateLabel(health.state)];
  parts.push(`${health.selectedChats} selected`);
  if (health.activeChatTitle) {
    const progress =
      health.importedMessages !== undefined && health.totalMessages !== undefined
        ? ` · ${health.importedMessages}/${health.totalMessages}`
        : '';
    parts.push(`importing ${health.activeChatTitle}${progress}`);
  }
  if (health.lastLiveAt) parts.push(`live ${formatTs(health.lastLiveAt)}`);
  if (health.lastReconciledAt) parts.push(`reconciled ${formatTs(health.lastReconciledAt)}`);
  if (health.error) parts.push(clip(health.error, 80));
  return parts.join(' · ');
}

export function renderTelegramHome(health: TelegramHealth): Rendered {
  const kb = new InlineKeyboard().text('🔍 browse chats', `tg:page:0:${queryRef('')}`).row();
  return {
    text: [
      'personal Telegram archive',
      `▸ ${renderTelegramStatusLine(health)}`,
      '',
      'search with /tg <query>, or browse all chats below.',
    ].join('\n'),
    keyboard: kb,
  };
}

export function renderTelegramDialogs(page: TelegramDialogPageView): Rendered {
  const { query, page: pageIndex, pageSize, total, dialogs } = page;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const qRef = queryRef(query);
  const kb = new InlineKeyboard();
  for (const dialog of dialogs) {
    const mark = dialog.selected ? '✅' : '▫️';
    kb.text(
      clip(`${mark} ${kindIcon(dialog.kind)} ${dialog.title}`, 50),
      `tg:chat:${peerRef(dialog.peerKey)}`,
    ).row();
  }
  const nav: string[] = [];
  if (pageIndex > 0) nav.push(`tg:page:${pageIndex - 1}:${qRef}`);
  if (pageIndex < totalPages - 1) nav.push(`tg:page:${pageIndex + 1}:${qRef}`);
  if (nav.length === 2) {
    kb.text('◀ prev', nav[0]!).text('next ▶', nav[1]!).row();
  } else if (nav.length === 1) {
    kb.text(pageIndex > 0 ? '◀ prev' : 'next ▶', nav[0]!).row();
  }
  kb.text('« home', 'tg:home');
  const queryLine = query ? `matching "${query}"` : 'all chats';
  const dialogLines = dialogs.map(
    (dialog) =>
      `${dialog.selected ? '✅' : '▫️'} ${kindIcon(dialog.kind)} ${dialog.title}${
        dialog.totalMessages !== undefined ? ` · ${dialog.totalMessages} msgs` : ''
      }`,
  );
  const text = [
    `telegram · ${queryLine}`,
    `▸ ${total} chats · page ${pageIndex + 1}/${totalPages}`,
    ...dialogLines,
    dialogs.length ? '' : 'no chats on this page.',
  ]
    .filter((line, i, arr) => line !== '' || i < arr.length - 1)
    .join('\n');
  return { text, keyboard: kb };
}

export function renderTelegramImportPrompt(view: TelegramChatStatusView): Rendered {
  const { chat } = view;
  const peer = peerRef(chat.peerKey);
  const total = view.import?.totalMessages;
  const text = [
    `${kindIcon(chat.kind)} ${chat.title}`,
    total !== undefined
      ? `import all ${total} available messages, media, and link snapshots into the local archive?`
      : 'import all available history, media, and link snapshots into the local archive?',
    '',
    'this is read-only — nothing is sent back to Telegram.',
  ].join('\n');
  return {
    text,
    keyboard: new InlineKeyboard()
      .text('▶ start import', `tg:import:${peer}`)
      .text('cancel', `tg:chat:${peer}`),
  };
}

export function renderTelegramChat(view: TelegramChatStatusView): Rendered {
  const { chat, import: job, downloadedMediaBytes, failedMedia, failedLinks } = view;
  const peer = peerRef(chat.peerKey);
  const lines = [
    `${kindIcon(chat.kind)} ${chat.title}`,
    `▸ kind · ${kindLabel(chat.kind)}${chat.username ? ` · @${chat.username}` : ''}`,
    `▸ selection · ${chat.selected ? 'archived' : 'not selected'}`,
  ];
  if (job) {
    lines.push(`▸ import · ${importLabel(job.state)}`);
    const counts =
      job.totalMessages !== undefined
        ? `${job.importedMessages}/${job.totalMessages} messages`
        : `${job.importedMessages} messages`;
    lines.push(`▸ progress · ${counts}`);
    if (job.oldestMessageId !== undefined) lines.push(`▸ oldest imported · #${job.oldestMessageId}`);
  } else if (chat.selected) {
    lines.push('▸ import · not started');
  }
  lines.push(`▸ media · ${formatBytes(downloadedMediaBytes)} downloaded`);
  if (failedMedia || failedLinks) {
    lines.push(`▸ failures · ${failedMedia} media · ${failedLinks} links`);
  }
  lines.push(`▸ last live · ${formatTs(chat.lastLiveAt)}`);
  lines.push(`▸ last reconciled · ${formatTs(chat.lastReconciledAt)}`);
  const error = chat.healthError ?? job?.lastError;
  if (error) lines.push(`▸ error · ${clip(error, 120)}`);
  if (job?.nextRetryAt) lines.push(`▸ next retry · ${formatTs(job.nextRetryAt)}`);

  const kb = new InlineKeyboard();
  if (!chat.selected) {
    kb.text('▶ import', `tg:import:${peer}`).row();
  } else if (job) {
    switch (job.state) {
      case 'paused':
        kb.text('▶ resume', `tg:resume:${peer}`).row();
        break;
      case 'scanning':
      case 'acquiring':
        kb.text('⏸ pause', `tg:pause:${peer}`)
          .text('✕ cancel', `tg:cancel:${peer}`)
          .row();
        break;
      case 'error':
        kb.text('↻ retry', `tg:retry:${peer}`).row();
        break;
      case 'cancelled':
        kb.text('▶ import', `tg:import:${peer}`).row();
        break;
      case 'complete':
        break;
    }
  }
  if (chat.selected) kb.text('🗑 remove archive', `tg:remove:${peer}`).row();
  kb.text('« dialogs', `tg:page:0:${queryRef('')}`);
  return { text: lines.join('\n'), keyboard: kb };
}
