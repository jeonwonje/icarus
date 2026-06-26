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
  classifyOutlookSender,
  outlookBlockReason,
  type SourcesConfig,
} from '../config/sources.js';
import { triageGray, type Verdict } from './outlook-triage.js';
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

function renderMessage(msg: PSTMessage, folder: string, filteredReason?: string): string {
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
  if (filteredReason) lines.push(`- **Filtered:** ${filteredReason}`);
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

export interface GrayRef {
  id: string;
  sender: string;
  subject: string;
  file: string; // current path inside _graytriage
}
interface TriageCounters {
  kept: number;
  filteredBlock: number;
  filteredLlm: number;
  gray: number;
  attachments: number;
  skipped: number;
}
interface TriageDirs {
  destDir: string;
  filteredDir: string;
  graytriageDir: string;
}

/** A path in `dir` for `name` that does not already exist, appending _2/_3/... on collision. */
export function uniquePath(dir: string, name: string): string {
  if (!fs.existsSync(path.join(dir, name))) return path.join(dir, name);
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let i = 2;
  while (fs.existsSync(path.join(dir, `${base}_${i}${ext}`))) i++;
  return path.join(dir, `${base}_${i}${ext}`);
}

/** Insert a `- **Filtered:** <reason>` line right after the Folder line. */
export function injectFilteredLine(content: string, reason: string): string {
  const lines = content.split('\n');
  const idx = lines.findIndex((l) => l.startsWith('- **Folder:**'));
  if (idx < 0) return content;
  lines.splice(idx + 1, 0, `- **Filtered:** ${reason}`);
  return lines.join('\n');
}

/** Move each parked gray file to dest (keep) or filtered (junk); remove _graytriage if empty. */
export function applyTriageVerdicts(
  gray: GrayRef[],
  verdicts: Map<string, Verdict>,
  dirs: TriageDirs,
  counters: TriageCounters,
): void {
  for (const g of gray) {
    const name = path.basename(g.file);
    const verdict = verdicts.get(g.id) ?? 'keep';
    try {
      if (verdict === 'junk') {
        const content = fs.readFileSync(g.file, 'utf-8');
        fs.mkdirSync(dirs.filteredDir, { recursive: true });
        fs.writeFileSync(uniquePath(dirs.filteredDir, name), injectFilteredLine(content, 'llm:junk'));
        fs.unlinkSync(g.file);
        counters.filteredLlm++;
      } else {
        fs.mkdirSync(dirs.destDir, { recursive: true });
        fs.renameSync(g.file, uniquePath(dirs.destDir, name));
        counters.kept++;
      }
    } catch (err) {
      logger.warn({ err, file: g.file }, 'outlook triage: move failed, leaving file in _graytriage (counted kept)');
      counters.kept++;
    }
  }
  try {
    if (fs.existsSync(dirs.graytriageDir) && fs.readdirSync(dirs.graytriageDir).length === 0) {
      fs.rmdirSync(dirs.graytriageDir);
    }
  } catch (err) {
    logger.warn({ err, dir: dirs.graytriageDir }, 'outlook triage: could not remove _graytriage');
  }
}

function walkFolder(
  folder: PSTFolder,
  cfg: SourcesConfig,
  dirs: TriageDirs,
  attachmentsDir: string,
  counters: TriageCounters,
  gray: GrayRef[],
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
          const name = messageFileName(msg.subject || '', date);
          const stem = name.replace(/\.md$/, '');

          let headers = '';
          try { headers = msg.transportMessageHeaders || ''; } catch { /* default '' */ }
          const verdict = classifyOutlookSender(cfg, { sender, isBulk: isBulkMessage(headers) });

          if (verdict === 'block') {
            fs.mkdirSync(dirs.filteredDir, { recursive: true });
            fs.writeFileSync(
              uniquePath(dirs.filteredDir, name),
              renderMessage(msg, folderName, outlookBlockReason(cfg, sender)),
            );
            counters.filteredBlock++;
          } else if (verdict === 'gray') {
            fs.mkdirSync(dirs.graytriageDir, { recursive: true });
            const file = uniquePath(dirs.graytriageDir, name);
            fs.writeFileSync(file, renderMessage(msg, folderName));
            gray.push({ id: `g${gray.length}`, sender, subject: msg.subject || '', file });
            counters.gray++;
          } else {
            fs.mkdirSync(dirs.destDir, { recursive: true });
            fs.writeFileSync(uniquePath(dirs.destDir, name), renderMessage(msg, folderName));
            counters.kept++;
          }

          extractAttachments(msg, attachmentsDir, counters, stem, cfg);
        }
      }
      msg = folder.getNextChild() as PSTMessage | null;
    }
  }

  if (folder.hasSubfolders) {
    for (const sub of folder.getSubFolders()) {
      walkFolder(sub, cfg, dirs, attachmentsDir, counters, gray);
    }
  }
}

export async function main(): Promise<void> {
  if (!OUTLOOK_PST_PATH) throw new Error('OUTLOOK_PST_PATH must be set in .env');
  if (!fs.existsSync(OUTLOOK_PST_PATH)) {
    throw new Error(`No .pst export found at ${OUTLOOK_PST_PATH}`);
  }
  const cfg = loadSourcesConfig();
  const destDir = rawOutlookDir();
  const dirs: TriageDirs = {
    destDir,
    filteredDir: path.join(destDir, '_filtered'),
    graytriageDir: path.join(destDir, '_graytriage'),
  };
  const attachmentsDir = path.join(destDir, 'attachments');
  const counters: TriageCounters = {
    kept: 0, filteredBlock: 0, filteredLlm: 0, gray: 0, attachments: 0, skipped: 0,
  };
  const gray: GrayRef[] = [];

  const pst = new PSTFile(OUTLOOK_PST_PATH);
  walkFolder(pst.getRootFolder(), cfg, dirs, attachmentsDir, counters, gray);

  const verdicts = await triageGray(
    gray.map((g) => ({ id: g.id, sender: g.sender, subject: g.subject })),
    { enabled: cfg.outlook.triageEnabled },
  );
  applyTriageVerdicts(gray, verdicts, dirs, counters);

  logger.info(
    {
      kept: counters.kept,
      filteredBlock: counters.filteredBlock,
      filteredLlm: counters.filteredLlm,
      gray: counters.gray,
      attachments: counters.attachments,
      skipped: counters.skipped,
    },
    'outlook ingest complete',
  );
  process.stdout.write(
    `Outlook ingest complete: ${counters.kept} kept, ` +
      `${counters.filteredBlock + counters.filteredLlm} filtered ` +
      `(${counters.filteredBlock} blocklist + ${counters.filteredLlm} llm-junk), ` +
      `${counters.gray} gray-triaged, ${counters.attachments} attachments kept, ${counters.skipped} skipped.\n`,
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
