import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { convert } from 'html-to-text';
import { PSTFile, PSTFolder, PSTMessage } from 'pst-extractor';
import { cfg } from '../../config.js';
import { log } from '../../log.js';
import {
  messageId,
  renderMessageMd,
  sanitizeAttachmentName,
  senderKey,
  slugify,
  snippetOf,
} from './message.js';
import type { CensusMessageInput, MailExportRow, MailMessageRow, MailStore } from './store.js';

/** Position in a depth-first walk. Folders are addressed by index path — `[0,2]` is
 *  root.getSubFolders()[0].getSubFolders()[2] — which is stable within one physical PST
 *  but NOT across re-exports, so the cursor is only ever used with its own export row. */
export interface MailScanCursor {
  queue: number[][];
  current: number[] | null;
  childIndex: number;
}

export interface ScanSliceResult {
  scanned: number;
  inserted: number;
  done: boolean;
  error?: string;
}

const BATCH = 50;
/** Inline HTML furniture — logos, tracking pixels, signature images. Never worth filing. */
const INLINE_IMAGE_MAX_BYTES = 20 * 1024;

/**
 * Outbound folders. This is a structural fact — mail the owner sent is not mail to triage,
 * has nothing to action, and its attachments are things he already has. It is deliberately
 * NOT a relevance judgement: Junk stays in, because deciding what is junk is the ranker's job.
 */
const OUTBOUND_FOLDERS = new Set(['sent items', 'sent', 'drafts', 'outbox']);

export function isOutboundFolder(name: string): boolean {
  return OUTBOUND_FOLDERS.has((name ?? '').trim().toLowerCase());
}

export function parseCursor(json: string | null): MailScanCursor | null {
  if (!json) return null;
  try {
    const raw = JSON.parse(json) as MailScanCursor;
    if (!Array.isArray(raw.queue)) return null;
    return {
      queue: raw.queue,
      current: raw.current ?? null,
      childIndex: typeof raw.childIndex === 'number' ? raw.childIndex : 0,
    };
  } catch {
    return null;
  }
}

/** Walk to a folder by index path. Returns null when the path no longer resolves. */
export function folderAt(root: PSTFolder, indexPath: number[]): PSTFolder | null {
  let node = root;
  for (const i of indexPath) {
    let subs: PSTFolder[];
    try {
      subs = node.getSubFolders();
    } catch {
      return null;
    }
    const next = subs[i];
    if (!next) return null;
    node = next;
  }
  return node;
}

/** Folders only — no message reads. Gives the cursor its work queue and a progress total. */
export function enumerateFolders(root: PSTFolder): { queue: number[][]; total: number } {
  const queue: number[][] = [];
  let total = 0;
  const visit = (folder: PSTFolder, indexPath: number[]): void => {
    try {
      if (folder.contentCount > 0 && !isOutboundFolder(folderLabel(folder))) {
        queue.push(indexPath);
        total += folder.contentCount;
      }
    } catch {
      /* unreadable counts are simply not queued */
    }
    let subs: PSTFolder[] = [];
    try {
      if (folder.hasSubfolders) subs = folder.getSubFolders();
    } catch (e) {
      log.warn({ err: String(e), indexPath }, 'mail census: unreadable subfolder listing');
      return;
    }
    subs.forEach((sub, i) => visit(sub, [...indexPath, i]));
  };
  visit(root, []);
  return { queue, total };
}

function folderLabel(folder: PSTFolder): string {
  try {
    return folder.displayName || '';
  } catch {
    return '';
  }
}

function headerOf(child: PSTMessage, folderPath: number[], folderName: string, childIndex: number): CensusMessageInput {
  return {
    messageKey: messageId(child),
    folderPath: JSON.stringify(folderPath),
    folderName,
    childIndex,
    sentAt: child.messageDeliveryTime?.toISOString() ?? null,
    senderName: child.senderName ?? '',
    // Internal Exchange senders come back as an X.500 DN, not an address
    // ("/o=exchangelabs/ou=…/cn=recipients/cn=7e11dfe5…"). Those are unique per sender,
    // unreadable in /mail, and impossible for a model to echo back, so grouping falls
    // back to the display name.
    senderEmail: senderKey(child.senderEmailAddress ?? '', child.senderName ?? ''),
    recipients: child.displayTo ?? '',
    subject: child.subject ?? '',
    attachmentCount: child.numberOfAttachments ?? 0,
  };
}

/**
 * Reads message headers into `mail_messages` until the budget expires or the walk finishes.
 * Deliberately never touches `body`, `bodyHTML`, or `getAttachment` — decompressing the
 * largest property on every message is the dominant cost of a walk, and 90% of the relevance
 * signal is in the subject and sender. Bodies are materialized later, for winners only.
 */
export async function scanSlice(
  store: MailStore,
  row: MailExportRow,
  opts: { maxMs: number; now?: () => number },
): Promise<ScanSliceResult> {
  const clock = opts.now ?? Date.now;
  const deadline = clock() + opts.maxMs;
  let scanned = row.scannedMessages;
  let inserted = 0;
  let pst: PSTFile | undefined;

  try {
    pst = new PSTFile(row.filePath);
    const root = pst.getRootFolder();

    let cursor = parseCursor(row.cursorJson);
    if (!cursor) {
      const { queue, total } = enumerateFolders(root);
      store.setTotalMessages(row.id, total);
      cursor = { queue, current: null, childIndex: 0 };
      store.saveCursor(row.id, JSON.stringify(cursor), scanned);
    }

    let batch: CensusMessageInput[] = [];
    const flush = (): void => {
      if (batch.length === 0) return;
      inserted += store.insertMessages(row.id, batch);
      batch = [];
    };

    while (cursor.current || cursor.queue.length > 0) {
      if (!cursor.current) {
        cursor.current = cursor.queue.shift() ?? null;
        cursor.childIndex = 0;
        if (!cursor.current) break;
      }

      const folder = folderAt(root, cursor.current);
      if (!folder) {
        log.warn({ indexPath: cursor.current }, 'mail census: folder path no longer resolves');
        cursor.current = null;
        continue;
      }
      const folderPath = cursor.current;
      const folderName = folderLabel(folder);

      let count = 0;
      try {
        count = folder.contentCount;
        folder.moveChildCursorTo(cursor.childIndex);
      } catch (e) {
        log.warn({ err: String(e), folderName }, 'mail census: folder cursor failed — skipping folder');
        cursor.current = null;
        continue;
      }

      let exhausted = false;
      while (cursor.childIndex < count) {
        let child: unknown;
        try {
          child = folder.getNextChild();
        } catch (e) {
          log.warn({ err: String(e), folderName }, 'mail census: child read failed — abandoning folder');
          exhausted = true;
          break;
        }
        if (!child) {
          exhausted = true;
          break;
        }
        const index = cursor.childIndex;
        cursor.childIndex += 1;
        scanned += 1;

        if (child instanceof PSTMessage && child.messageClass.startsWith('IPM.Note')) {
          try {
            batch.push(headerOf(child, folderPath, folderName, index));
          } catch (e) {
            log.warn({ err: String(e) }, 'mail census: unreadable header — skipping message');
          }
        }

        if (batch.length >= BATCH) {
          // Commit synchronously, then yield. Never hold a transaction across an await —
          // a concurrent turn writes `turns` on this same connection.
          flush();
          store.saveCursor(row.id, JSON.stringify(cursor), scanned);
          await yieldToLoop();
          if (clock() >= deadline) {
            return { scanned, inserted, done: false };
          }
        }
      }

      if (exhausted || cursor.childIndex >= count) {
        cursor.current = null;
        cursor.childIndex = 0;
      }
      flush();
      store.saveCursor(row.id, JSON.stringify(cursor), scanned);
      if (clock() >= deadline) return { scanned, inserted, done: false };
    }

    flush();
    store.saveCursor(row.id, JSON.stringify(cursor), scanned);
    return { scanned, inserted, done: true };
  } catch (e) {
    return { scanned, inserted, done: false, error: String(e).slice(0, 400) };
  } finally {
    // watcher.ts never did this — one leaked fd per extraction, per day, forever.
    try {
      pst?.close();
    } catch {
      /* already gone */
    }
  }
}

function bodyText(msg: PSTMessage): string {
  const plain = (msg.body ?? '').trim();
  if (plain) return plain;
  const html = (msg.bodyHTML ?? '').trim();
  return html ? convert(html, { wordwrap: false }).trim() : '';
}

/** Attachments worth filing — real documents, not the HTML furniture of a newsletter. */
export function isFileableAttachment(att: {
  contentId: string;
  isAttachmentInvisibleInHtml: boolean;
  filesize: number;
  longFilename: string;
  filename: string;
}): boolean {
  if (att.isAttachmentInvisibleInHtml) return false;
  if ((att.contentId ?? '').trim()) return false; // inline HTML asset
  const name = (att.longFilename || att.filename || '').toLowerCase();
  const isImage = /\.(png|gif|jpe?g|bmp|webp|svg)$/.test(name);
  if (isImage && att.filesize < INLINE_IMAGE_MAX_BYTES) return false;
  return true;
}

export interface MaterializeResult {
  mdPath: string;
  attDir: string | null;
  attachments: string[];
}

/**
 * Writes the body markdown and eligible attachments for one already-ranked message.
 * Only ever called for messages at or above the read threshold — this is why the census
 * does not write files.
 */
export function materializeMessage(
  row: MailMessageRow,
  pst: PSTFile,
  opts: { inboxDir?: string } = {},
): MaterializeResult {
  const root = pst.getRootFolder();
  const indexPath = JSON.parse(row.folderPath) as number[];
  const folder = folderAt(root, indexPath);
  if (!folder) throw new Error(`folder path no longer resolves: ${row.folderPath}`);

  const msg = findMessage(folder, row);
  if (!msg) throw new Error(`message not found in ${row.folderName}: ${row.messageKey}`);

  const inboxDir = opts.inboxDir ?? cfg.inboxDir;
  const day = (msg.messageDeliveryTime ?? new Date()).toISOString().slice(0, 10);
  const dir = path.join(inboxDir, 'connectors', 'mail', day);
  mkdirSync(dir, { recursive: true });

  const base = `${slugify(msg.subject)}-${createHash('sha256').update(row.messageKey).digest('hex').slice(0, 8)}`;
  const mdPath = path.join(dir, `${base}.md`);
  writeFileSync(
    mdPath,
    renderMessageMd({
      id: row.messageKey,
      from: msg.senderName,
      fromEmail: msg.senderEmailAddress,
      to: msg.displayTo,
      date: msg.messageDeliveryTime?.toISOString() ?? 'unknown',
      subject: msg.subject,
      body: bodyText(msg),
    }),
  );

  const attachments = writeAttachments(msg, path.join(dir, `${base}-att`));
  return { mdPath, attDir: attachments.length > 0 ? path.join(dir, `${base}-att`) : null, attachments };
}

/** Seek to the recorded child index, then fall back to a linear rescan of the folder. */
function findMessage(folder: PSTFolder, row: MailMessageRow): PSTMessage | null {
  try {
    folder.moveChildCursorTo(row.childIndex);
    const direct = folder.getNextChild();
    if (direct instanceof PSTMessage && messageId(direct) === row.messageKey) return direct;
  } catch {
    /* fall through to rescan */
  }
  try {
    folder.moveChildCursorTo(0);
    for (let i = 0; i < folder.contentCount; i++) {
      const child = folder.getNextChild();
      if (!child) break;
      if (child instanceof PSTMessage && messageId(child) === row.messageKey) return child;
    }
  } catch (e) {
    log.warn({ err: String(e), key: row.messageKey }, 'mail materialize: rescan failed');
  }
  return null;
}

function writeAttachments(msg: PSTMessage, dir: string): string[] {
  const written: string[] = [];
  for (let i = 0; i < msg.numberOfAttachments; i++) {
    let out: ReturnType<typeof createWriteStream> | null = null;
    try {
      const att = msg.getAttachment(i);
      if (!isFileableAttachment(att)) continue;
      const stream = att.fileInputStream;
      if (!stream) continue;
      mkdirSync(dir, { recursive: true });
      const name = sanitizeAttachmentName(att.longFilename || att.filename, i);
      const dest = path.join(dir, name);
      out = createWriteStream(dest);
      out.on('error', (e) => log.warn({ err: String(e) }, 'mail attachment write failed'));
      const buffer = Buffer.alloc(8176);
      let bytesRead: number;
      do {
        bytesRead = stream.readBlock(buffer);
        if (bytesRead > 0) out.write(buffer.subarray(0, bytesRead));
      } while (bytesRead === buffer.length);
      out.end();
      written.push(name);
    } catch (e) {
      out?.destroy(); // avoid leaking the fd if readBlock threw mid-stream
      log.warn({ err: String(e), i }, 'mail attachment extraction failed');
    }
  }
  return written;
}
