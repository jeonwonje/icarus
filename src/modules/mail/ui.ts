import { InlineKeyboard } from 'grammy';
import { clip, type Rendered } from '../../telegram/ui.js';
import { rankLabel } from './message.js';
import { MAIL_SETTINGS, num, policy } from './sweep.js';
import type { MailStore } from './store.js';

const PAGE = 8;

const stateLabel = (s: string): string =>
  ({ census: 'reading the export', ranking: 'sorting', triaging: 'reading the important ones' })[s] ?? s;

export function renderMailHome(store: MailStore): Rendered {
  const [exp] = store.listExports(1);
  const c = store.counts();
  const senders = store.senderCounts();
  const read = num(MAIL_SETTINGS.readThreshold);

  const lines = ['mail'];
  if (!exp) {
    lines.push('▸ export · nothing dropped yet');
  } else {
    const mb = Math.round(exp.bytes / 1_000_000);
    lines.push(`▸ export · ${clip(exp.fileName, 40)} · ${mb} MB · ${stateLabel(exp.state)}`);
    if (exp.totalMessages) {
      lines.push(`▸ read so far · ${exp.scannedMessages.toLocaleString()} of ${exp.totalMessages.toLocaleString()}`);
    }
    if (exp.lastError) lines.push(`▸ snag · ${clip(exp.lastError, 80)}`);
  }
  lines.push(`▸ backlog · ${c.toRank} to sort · ${c.toRead} to read · ${c.setAside} set aside`);
  lines.push(`▸ reading anything · ${rankLabel(read)} and above`);
  lines.push(`▸ senders judged · ${senders.model} by me · ${senders.owner} by you`);
  lines.push(`▸ filed · ${c.filed}`);

  const kb = new InlineKeyboard()
    .text('run now', 'mail:run')
    .row()
    .text(`read: ${rankLabel(3)}`, 'mail:th:3')
    .text(`${rankLabel(2)}`, 'mail:th:2')
    .text(`${rankLabel(1)}`, 'mail:th:1')
    .row()
    .text('senders', 'mail:senders:0')
    .text('filed', 'mail:filed:0')
    .text('links', 'mail:links:0');
  if (exp && (exp.state === 'paused' || exp.state === 'error')) {
    kb.row().text('retry this export', `mail:retry:${exp.id}`);
  }
  return { text: lines.join('\n'), keyboard: kb };
}

export function renderSenderList(store: MailStore, page: number): Rendered {
  const rows = store.listSenders(PAGE, page * PAGE);
  const kb = new InlineKeyboard();
  for (const r of rows) {
    kb.text(clip(`${r.verdict} · ${r.email} (${r.hits})`, 55), `mail:sender:${r.id}`).row();
  }
  if (page > 0) kb.text('back', `mail:senders:${page - 1}`);
  if (rows.length === PAGE) kb.text('more', `mail:senders:${page + 1}`);
  kb.row().text('mail', 'mail:home');

  const text =
    rows.length === 0
      ? 'no senders judged yet — that happens on the first sweep.'
      : 'who I read and who I skip. Tap one to change my mind.';
  return { text, keyboard: kb };
}

export function renderSender(store: MailStore, id: number): Rendered {
  const s = store.getSenderById(id);
  if (!s) return { text: 'that sender is gone.', keyboard: new InlineKeyboard().text('mail', 'mail:home') };
  const text = [
    s.email,
    '',
    `▸ verdict · ${s.verdict} (${s.source === 'owner' ? 'your call' : 'my call'})`,
    `▸ why · ${clip(s.why || 'no reason recorded', 120)}`,
    `▸ applied to · ${s.hits} message(s)`,
  ].join('\n');
  const kb = new InlineKeyboard()
    .text('always read', `mail:sender:${id}:relevant`)
    .text('depends', `mail:sender:${id}:sometimes`)
    .row()
    .text('never read', `mail:sender:${id}:noise`)
    .text('forget', `mail:sender:${id}:del`)
    .row()
    .text('senders', 'mail:senders:0');
  return { text, keyboard: kb };
}

export function renderFiled(store: MailStore, page: number): Rendered {
  const rows = store.listFiled(PAGE, page * PAGE);
  const text =
    rows.length === 0
      ? 'nothing filed yet.'
      : ['what I filed — raw is immutable, so this is a record, not a control panel', '']
          .concat(rows.map((r) => `▸ ${clip(r.displayName, 40)} → ${r.project}`))
          .join('\n');
  const kb = new InlineKeyboard();
  if (page > 0) kb.text('back', `mail:filed:${page - 1}`);
  if (rows.length === PAGE) kb.text('more', `mail:filed:${page + 1}`);
  kb.row().text('mail', 'mail:home');
  return { text, keyboard: kb };
}

export function renderLinks(store: MailStore, page: number): Rendered {
  const rows = store.listLinks(PAGE, page * PAGE);
  const text =
    rows.length === 0
      ? 'no links kept yet.'
      : ['links worth keeping', '']
          .concat(rows.map((r) => `▸ ${clip(r.title || r.url, 45)} → ${r.project}\n  ${clip(r.url, 60)}`))
          .join('\n');
  const kb = new InlineKeyboard();
  if (page > 0) kb.text('back', `mail:links:${page - 1}`);
  if (rows.length === PAGE) kb.text('more', `mail:links:${page + 1}`);
  kb.row().text('mail', 'mail:home');
  return { text, keyboard: kb };
}

export function renderPolicy(): Rendered {
  const text = [
    'what I look for when sorting mail:',
    '',
    policy(),
    '',
    'change it with: /mail policy <text>',
  ].join('\n');
  return { text, keyboard: new InlineKeyboard().text('mail', 'mail:home') };
}
