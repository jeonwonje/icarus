/** Pure mail helpers — no I/O, no DB, no pst-extractor. Everything here is unit-testable. */

export interface MailMeta {
  id: string;
  from: string;
  fromEmail: string;
  to: string;
  date: string; // ISO
  subject: string;
  body: string;
}

export function slugify(s: string): string {
  const slug = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return slug || 'no-subject';
}

/** Identity of one on-disk export: same name+size+mtime ⇒ already handled. */
export function fileSignature(name: string, size: number, mtimeMs: number): string {
  return `${name}|${size}|${Math.round(mtimeMs)}`;
}

/** Stable per-message id: RFC internet id when present, else descriptor node + delivery time.
 *  descriptorNodeId is loose on purpose — pst-extractor returns a Long, tests pass a number. */
export function messageId(msg: {
  internetMessageId: string;
  descriptorNodeId: number | { toString(): string };
  messageDeliveryTime: Date | null;
}): string {
  const internet = msg.internetMessageId?.trim();
  if (internet) return internet;
  return `desc-${msg.descriptorNodeId}-${msg.messageDeliveryTime?.toISOString() ?? 'unknown'}`;
}

export function renderMessageMd(m: MailMeta): string {
  return [
    `# ${m.subject || '(no subject)'}`,
    '',
    `from: ${m.from} <${m.fromEmail}>`,
    `to: ${m.to}`,
    `date: ${m.date}`,
    `id: ${m.id}`,
    '',
    m.body.trim(),
    '',
  ].join('\n');
}

/** Collapsed, truncated preview for the ranking table. Never the whole body — the census
 *  pass must not force decompression of the largest property on every message. */
export function snippetOf(body: string, max = 200): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** Lowercased address for sender grouping; '' when the PST gave us nothing usable. */
export function normalizeEmail(raw: string): string {
  const trimmed = (raw ?? '').trim().replace(/^<|>$/g, '');
  return trimmed.includes('@') ? trimmed.toLowerCase() : '';
}

/** Sender bucket key — a real address when we have one, else the display name. */
export function senderKey(email: string, displayName: string): string {
  return normalizeEmail(email) || `name:${(displayName ?? '').trim().toLowerCase()}` || 'unknown';
}

export const RANK_BANDS = {
  0: 'noise',
  1: 'skim',
  2: 'keep',
  3: 'act',
} as const;

export function rankLabel(rank: number | null | undefined): string {
  if (rank === null || rank === undefined) return 'unranked';
  return RANK_BANDS[rank as 0 | 1 | 2 | 3] ?? String(rank);
}

const WINDOWS_UNSAFE = /[<>:"/\\|?*\x00-\x1f]/g;

export function sanitizeAttachmentName(name: string, index: number): string {
  const base = (name || `attachment-${index}`).replace(WINDOWS_UNSAFE, '_').trim();
  return (base || `attachment-${index}`).slice(0, 120);
}
