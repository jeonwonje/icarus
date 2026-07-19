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
