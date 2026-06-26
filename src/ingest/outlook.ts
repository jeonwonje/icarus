import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { PSTFile, PSTFolder, PSTMessage, PSTAttachment } from 'pst-extractor';

import { OUTLOOK_PST_PATH } from '../core/config.js';
import {
  loadSourcesConfig,
  outlookFolderAllowed,
  outlookSenderAllowed,
  outlookAttachmentAllowed,
  type SourcesConfig,
} from '../config/sources.js';
import { rawOutlookDir } from '../memory/scaffold.js';
import { sanitizeFileName } from '../core/slug.js';
import { logger } from '../core/logger.js';

/** Pure: build a safe, date-prefixed markdown filename. Exported for tests. */
export function messageFileName(subject: string, dateIso: string): string {
  const date = (dateIso || '').slice(0, 10) || 'undated';
  const slugSource = subject.trim() || 'no-subject';
  const slug = sanitizeFileName(slugSource).slice(0, 60) || 'no-subject';
  return `${date}_${slug}.md`;
}

function senderOf(msg: PSTMessage): string {
  return (msg.senderEmailAddress || msg.senderName || 'unknown').trim();
}

/** Lowercased extension without the dot; '' when the name has none. */
function fileExt(name: string): string {
  const m = /\.([A-Za-z0-9]{1,6})$/.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

/** Heuristic: true when transport headers mark the message as bulk/list/auto mail. */
export function isBulkMessage(headers: string): boolean {
  const h = (headers || '').toLowerCase();
  return (
    /list-unsubscribe/.test(h) ||
    /precedence:\s*(bulk|list|junk)/.test(h) ||
    /auto-submitted:\s*auto/.test(h)
  );
}

function renderMessage(msg: PSTMessage, folder: string): string {
  const subject = msg.subject || '(no subject)';
  const from = senderOf(msg);
  const date = msg.clientSubmitTime ? msg.clientSubmitTime.toISOString() : '';
  const body = msg.body || msg.bodyRTF || '';
  let headers = '';
  try { headers = msg.transportMessageHeaders || ''; } catch { /* default '' */ }
  const lines = [
    `# ${subject}`,
    '',
    `- **From:** ${from}`,
    `- **Date:** ${date}`,
    `- **Folder:** ${folder}`,
  ];
  if (isBulkMessage(headers)) lines.push(`- **Bulk:** true`);
  lines.push('', '---', '', body, '');
  return lines.join('\n');
}

function extractAttachments(
  msg: PSTMessage,
  attachmentsDir: string,
  counters: { attachments: number; skipped: number },
  messageStem: string,
  cfg: SourcesConfig,
): void {
  try {
    const count = msg.numberOfAttachments;
    if (!count) return;
    fs.mkdirSync(attachmentsDir, { recursive: true });
    for (let i = 0; i < count; i++) {
      try {
        const att: PSTAttachment = msg.getAttachment(i);
        const rawName = (att.longFilename || att.filename || '').trim();
        const ext = fileExt(rawName);
        let contentId = '';
        let mimeTag = '';
        let sizeBytes = 0;
        try { contentId = att.contentId || ''; } catch { /* default '' */ }
        try { mimeTag = att.mimeTag || ''; } catch { /* default '' */ }
        try { sizeBytes = att.filesize || 0; } catch { /* default 0 */ }

        if (!outlookAttachmentAllowed(cfg, { ext, contentId, mimeTag, sizeBytes })) {
          counters.skipped++;
          continue;
        }

        const safeName = sanitizeFileName(rawName || `attachment_${i}`).slice(0, 80) || `attachment_${i}`;
        // Prefix with per-message stem so attachments from different messages never collide
        const destName = `${messageStem}__${i}_${safeName}`;
        const destPath = path.join(attachmentsDir, destName);

        const stream = att.fileInputStream;
        if (!stream) {
          logger.warn({ rawName }, 'outlook attachment: no fileInputStream, skipping');
          continue;
        }

        const chunks: Buffer[] = [];
        const blockSize = 8176;
        const buf = Buffer.alloc(blockSize);
        let bytesRead: number;
        while ((bytesRead = stream.read(buf)) > 0) {
          chunks.push(buf.slice(0, bytesRead));
        }
        fs.writeFileSync(destPath, Buffer.concat(chunks));
        counters.attachments++;
      } catch (attErr) {
        logger.warn({ err: attErr, index: i }, 'outlook attachment: error writing attachment, skipping');
      }
    }
  } catch (blockErr) {
    logger.warn({ err: blockErr }, 'outlook attachment: error processing attachments for message, skipping');
  }
}

function walkFolder(
  folder: PSTFolder,
  cfg: SourcesConfig,
  destDir: string,
  counters: { written: number; attachments: number; skipped: number },
): void {
  const folderName = folder.displayName || 'Unknown';
  const folderAllowed = outlookFolderAllowed(cfg, folderName);

  if (folderAllowed && folder.contentCount > 0) {
    let msg = folder.getNextChild() as PSTMessage | null;
    while (msg) {
      if (msg instanceof PSTMessage) {
        const sender = senderOf(msg);
        if (outlookSenderAllowed(cfg, sender)) {
          const date = msg.clientSubmitTime ? msg.clientSubmitTime.toISOString() : '';
          const file = path.join(destDir, messageFileName(msg.subject || '', date));
          fs.mkdirSync(destDir, { recursive: true });
          fs.writeFileSync(file, renderMessage(msg, folderName));
          counters.written++;

          const attachmentsDir = path.join(rawOutlookDir(), 'attachments');
          const messageStem = messageFileName(msg.subject || '', date).replace(/\.md$/, '');
          extractAttachments(msg, attachmentsDir, counters, messageStem, cfg);
        }
      }
      msg = folder.getNextChild() as PSTMessage | null;
    }
  }

  if (folder.hasSubfolders) {
    for (const sub of folder.getSubFolders()) {
      walkFolder(sub, cfg, destDir, counters);
    }
  }
}

export async function main(): Promise<void> {
  if (!OUTLOOK_PST_PATH) throw new Error('OUTLOOK_PST_PATH must be set in .env');
  if (!fs.existsSync(OUTLOOK_PST_PATH)) {
    throw new Error(`No .pst export found at ${OUTLOOK_PST_PATH}`);
  }
  const cfg = loadSourcesConfig();
  const pst = new PSTFile(OUTLOOK_PST_PATH);
  const counters = { written: 0, attachments: 0, skipped: 0 };
  walkFolder(pst.getRootFolder(), cfg, rawOutlookDir(), counters);
  logger.info(
    { written: counters.written, attachments: counters.attachments, skipped: counters.skipped },
    'outlook ingest complete',
  );
  process.stdout.write(
    `Outlook ingest complete: ${counters.written} messages, ${counters.attachments} attachments kept, ${counters.skipped} skipped.\n`,
  );
}

// Run when invoked directly (tsx src/ingest/outlook.ts or node dist/ingest/outlook.js).
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    logger.error({ err }, 'outlook ingest failed');
    process.stderr.write(`Outlook ingest failed: ${err instanceof Error ? err.message : err}\n`);
    process.exit(1);
  });
}
