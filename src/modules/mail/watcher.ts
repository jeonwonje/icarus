import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, statSync, writeFileSync, createWriteStream } from 'node:fs';
import path from 'node:path';
import { Cron } from 'croner';
import { PSTFile, PSTFolder, PSTMessage } from 'pst-extractor';
import { cfg } from '../../config.js';
import { getSetting, now, setSetting } from '../../db.js';
import { log } from '../../log.js';
import { submitTurn } from '../../queue.js';
import { ownerVoice } from '../../agent/ownerVoice.js';
import { DIGEST_STYLE } from '../../agent/digestStyle.js';
import { sendOwner } from '../../telegram/send.js';
import { isProcessed, markProcessed } from '../../processedStore.js';
import { getMailConfig } from './config.js';

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

// ---- watcher ---------------------------------------------------------------

const STALL_MS = 36 * 60 * 60_000;
const sanitize = (name: string) => name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120);

/** name → last-seen size/mtime; a file is "ready" when unchanged across two polls. */
const pollState = new Map<string, { size: number; mtimeMs: number }>();

export function formatMailStatusLine(p: {
  exportAt?: string | null;
  parse?: string | null;
}): string {
  return `▸ mail · export ${p.exportAt?.slice(0, 16) ?? 'never'} · parse ${p.parse ?? 'never'}`;
}

export function mailStatusLine(): string | null {
  getMailConfig();
  return formatMailStatusLine({
    exportAt: getSetting('mail_last_export_at'),
    parse: getSetting('mail_last_parse'),
  });
}

export function registerMailWatcher(): void {
  const { dropDir } = getMailConfig();
  new Cron('*/5 * * * *', { protect: true }, () => void pollMailDrop());
  log.info({ dir: dropDir }, 'mail watcher registered');
}

export async function pollMailDrop(): Promise<void> {
  try {
    const dir = getMailConfig().dropDir;
    let names: string[];
    try {
      names = readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.pst'));
    } catch (e) {
      log.warn({ err: String(e) }, 'mail drop dir unreadable');
      return;
    }
    for (const name of names) {
      const p = path.join(dir, name);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(p);
      } catch (e) {
        log.warn({ err: String(e), name }, 'mail export vanished before stat — skipping this poll');
        continue;
      }
      const prev = pollState.get(name);
      pollState.set(name, { size: st.size, mtimeMs: st.mtimeMs });
      const ready = prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs;
      if (!ready) continue; // still syncing (or first sighting) — next poll decides
      const sig = fileSignature(name, st.size, st.mtimeMs);
      if (isProcessed('mail-file', sig)) continue;
      // Always attempted-once: mark processed and record settings regardless of outcome, so a
      // poison export (throws partway through) can't be re-parsed and re-DMed every 5 minutes.
      const result = extractNewMessages(p);
      markProcessed('mail-file', sig);
      setSetting('mail_last_export_at', now());
      setSetting('mail_last_parse', `${now()} · ${result.files.length} new`);
      log.info({ pst: name, newMessages: result.files.length, error: result.error }, 'mail export parsed');
      if (result.error) {
        await sendOwner(
          `mail export ${name} parsed with errors: ${result.error.slice(0, 200)} — salvaged ${result.files.length} new message(s); this export won't be retried.`,
        );
      }
      if (result.files.length > 0) enqueueTriage(result.files);
    }
    checkStall();
  } catch (e) {
    log.error({ err: String(e) }, 'mail poll failed');
    await sendOwner(ownerVoice.ops.mailPipelineError(String(e)));
  }
}

function checkStall(): void {
  const last = getSetting('mail_last_export_at');
  if (!last) return; // never seen an export — nothing to compare against
  if (Date.now() - new Date(last).getTime() < STALL_MS) return;
  if (getSetting('mail_stall_notified') === last) return; // already nudged for this stall
  setSetting('mail_stall_notified', last);
  void sendOwner(ownerVoice.ops.mailStalled(last));
}

// ---- extraction ------------------------------------------------------------

/** Walk the PST, write never-seen messages + attachments to the inbox, return new file paths.
 *  Catches internally so whatever was salvaged before a throw is still returned — the caller
 *  marks the export processed exactly once (error or not) rather than retrying it forever. */
function extractNewMessages(pstPath: string): { files: string[]; error?: string } {
  const written: string[] = [];
  try {
    const pst = new PSTFile(pstPath);
    walkFolder(pst.getRootFolder(), written);
    return { files: written };
  } catch (e) {
    return { files: written, error: String(e) };
  }
}

function walkFolder(folder: PSTFolder, written: string[]): void {
  try {
    if (folder.hasSubfolders) for (const sub of folder.getSubFolders()) walkFolder(sub, written);
  } catch (e) {
    log.warn({ err: String(e) }, 'skipping subfolder listing — abandoning this branch');
  }
  if (folder.contentCount <= 0) return;
  try {
    let child = folder.getNextChild();
    while (child) {
      if (child instanceof PSTMessage && child.messageClass.startsWith('IPM.Note')) {
        try {
          const p = writeMessage(child);
          if (p) written.push(p);
        } catch (e) {
          log.warn({ err: String(e), subject: child.subject }, 'skipping unparseable message');
        }
      }
      child = folder.getNextChild();
    }
  } catch (e) {
    log.warn({ err: String(e) }, 'folder cursor failed — abandoning this folder');
  }
}

function writeMessage(msg: PSTMessage): string | null {
  const id = messageId(msg);
  if (isProcessed('mail', id)) return null;
  const delivered = msg.messageDeliveryTime;
  const day = (delivered ?? new Date()).toISOString().slice(0, 10);
  const dir = path.join(cfg.inboxDir, 'connectors', 'mail', day);
  mkdirSync(dir, { recursive: true });
  const base = `${slugify(msg.subject)}-${createHash('sha256').update(id).digest('hex').slice(0, 8)}`;
  const mdPath = path.join(dir, `${base}.md`);
  writeFileSync(
    mdPath,
    renderMessageMd({
      id,
      from: msg.senderName,
      fromEmail: msg.senderEmailAddress,
      to: msg.displayTo,
      date: delivered?.toISOString() ?? 'unknown',
      subject: msg.subject,
      body: msg.body || msg.bodyHTML,
    }),
  );
  if (msg.numberOfAttachments > 0) writeAttachments(msg, path.join(dir, `${base}-att`));
  markProcessed('mail', id);
  return mdPath;
}

function writeAttachments(msg: PSTMessage, dir: string): void {
  for (let i = 0; i < msg.numberOfAttachments; i++) {
    let out: ReturnType<typeof createWriteStream> | null = null;
    try {
      const att = msg.getAttachment(i);
      const stream = att.fileInputStream;
      if (!stream) continue;
      mkdirSync(dir, { recursive: true });
      const name = sanitize(att.longFilename || att.filename || `attachment-${i}`);
      out = createWriteStream(path.join(dir, name));
      out.on('error', (e) => log.warn({ err: String(e) }, 'attachment write failed'));
      const buffer = Buffer.alloc(8176);
      let bytesRead: number;
      do {
        bytesRead = stream.readBlock(buffer);
        if (bytesRead > 0) out.write(buffer.subarray(0, bytesRead));
      } while (bytesRead === buffer.length);
      out.end();
    } catch (e) {
      out?.destroy(); // avoid leaking the fd if readBlock threw mid-stream
      log.warn({ err: String(e), i }, 'attachment extraction failed');
    }
  }
}

// ---- triage ----------------------------------------------------------------

function enqueueTriage(files: string[]): void {
  const MAX_LISTED = 100;
  const listed = files.slice(0, MAX_LISTED);
  const extra = files.length - MAX_LISTED;
  const extraLine = extra > 0 ? `\n…and ${extra} more in the same directories` : '';
  const bulkNote =
    extra > 0
      ? `\n\nThis is likely a large/historical import — prioritize the most recent dates and clearly urgent subjects, roll the rest into one backlog summary line in the digest, and say explicitly what was skimmed vs read.`
      : '';
  const prompt = `You are running the mail triage job. ${files.length} new email(s) landed as markdown files (attachments in sibling "-att" dirs):

${listed.map((f) => `- ${f}`).join('\n')}${extraLine}

Read EVERY file. Discard spam/noise silently. For anything real, actually investigate: follow links (browser tools are available for pages WebFetch can't handle), read attachments and images, extract deadlines, actions, and amounts. Record durable facts in your memory directory. For hard deadlines, surface them prominently in the digest (calendar integration comes later).${bulkNote}

Your final reply is DMed to Jeon as the mail digest.

${DIGEST_STYLE}`;
  submitTurn({
    jid: 'job:mail-triage',
    kind: 'job:mail-triage',
    lines: [{ ts: new Date(), text: prompt }],
    capMs: cfg.reflectionCapMs,
    browser: true,
    onDone: (res) => {
      let body: string;
      if (res.status === 'ok') {
        body = res.finalText;
      } else {
        const shown = files.slice(0, 5);
        const more = files.length > 5 ? `\n…and ${files.length - 5} more` : '';
        body = `mail triage failed: ${res.error ?? 'unknown'} — batch preserved on disk (${files.length} files): ${shown.join('\n')}${more}`;
      }
      if (body.trim()) void sendOwner(body);
    },
  });
}
