import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { now } from '../../db.js';
import type { TurnResult } from '../../queue.js';
import type {
  TelegramDialog,
  TelegramHealth,
  TelegramHealthState,
  TelegramImportState,
  TelegramMessage,
  TelegramPeerKind,
  TelegramPollSnapshot,
} from './types.js';

const TRIAGE_FAILURE_ALERT_THRESHOLD = 3;
/** Marks the pauses the lane itself may lift once the archive volume has room again. */
const LOW_DISK_PREFIX = 'low disk: ';
/** Work states that still owe the import something; anything else is terminal. */
const OPEN_WORK_STATES = "('pending','in_progress','retry','paused')";

const computeVersionHash = (input: {
  text: string;
  editedAt?: string | null;
  entitiesJson: string;
  reactionsJson: string;
  poll?: TelegramPollSnapshot | null;
}): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        text: input.text,
        editedAt: input.editedAt ?? null,
        entitiesJson: input.entitiesJson,
        reactionsJson: input.reactionsJson,
        poll: input.poll ?? null,
      }),
    )
    .digest('hex');

const hashVersion = (message: TelegramMessage): string =>
  computeVersionHash({
    text: message.text,
    editedAt: message.editedAt,
    entitiesJson: message.entitiesJson,
    reactionsJson: message.reactionsJson,
    poll: message.poll,
  });

export interface TelegramImportRow {
  peerKey: string;
  state: TelegramImportState;
  totalMessages?: number;
  importedMessages: number;
  oldestMessageId?: number;
  nextRetryAt?: string;
  lastError?: string;
}

export interface TelegramWorkItem {
  id: number;
  peerKey: string;
  kind: 'media' | 'link' | 'targeted_fetch';
  itemKey: string;
  state: string;
  attempts: number;
  nextRetryAt?: string;
}

export interface TelegramMessageRow {
  peerKey: string;
  messageId: number;
  senderName?: string;
  sentAt: string;
  text: string;
  deletedAt?: string;
}

export interface TelegramChatRow {
  peerKey: string;
  kind: TelegramPeerKind;
  title: string;
  username?: string;
  accessHash?: string;
  selected: boolean;
  lastLiveAt?: string;
  lastReconciledAt?: string;
  healthError?: string;
}

export interface TelegramMediaTarget {
  mediaKey: string;
  peerKey: string;
  messageId: number;
  expectedSize?: number;
  status: string;
  blobHash?: string;
}

export interface TelegramLinkTarget {
  id: number;
  peerKey: string;
  messageId: number;
  url: string;
  normalizedUrl: string;
  status: string;
}

export interface TelegramImportSummary {
  title: string;
  importedMessages: number;
  totalMessages?: number;
  downloadedMediaBytes: number;
  linkSnapshots: number;
  failedMedia: number;
  failedLinks: number;
}

interface RawChatRow {
  peer_key: string;
  kind: TelegramPeerKind;
  title: string;
  username: string | null;
  access_hash: string | null;
  selected: number;
  last_live_at: string | null;
  last_reconciled_at: string | null;
  health_error: string | null;
}

interface RawImportRow {
  peer_key: string;
  state: TelegramImportState;
  total_messages: number | null;
  imported_messages: number;
  oldest_message_id: number | null;
  next_retry_at: string | null;
  last_error: string | null;
}

interface RawWorkItemRow {
  id: number;
  peer_key: string;
  kind: 'media' | 'link' | 'targeted_fetch';
  item_key: string;
  state: string;
  attempts: number;
  next_retry_at: string | null;
}

interface RawMessageRow {
  peer_key: string;
  message_id: number;
  sender_name: string | null;
  sent_at: string;
  text: string;
  deleted_at: string | null;
}

const mapChatRow = (row: RawChatRow): TelegramChatRow => ({
  peerKey: row.peer_key,
  kind: row.kind,
  title: row.title,
  username: row.username ?? undefined,
  accessHash: row.access_hash ?? undefined,
  selected: row.selected === 1,
  lastLiveAt: row.last_live_at ?? undefined,
  lastReconciledAt: row.last_reconciled_at ?? undefined,
  healthError: row.health_error ?? undefined,
});

const mapImportRow = (row: RawImportRow): TelegramImportRow => ({
  peerKey: row.peer_key,
  state: row.state,
  totalMessages: row.total_messages ?? undefined,
  importedMessages: row.imported_messages,
  oldestMessageId: row.oldest_message_id ?? undefined,
  nextRetryAt: row.next_retry_at ?? undefined,
  lastError: row.last_error ?? undefined,
});

const mapWorkItem = (row: RawWorkItemRow): TelegramWorkItem => ({
  id: row.id,
  peerKey: row.peer_key,
  kind: row.kind,
  itemKey: row.item_key,
  state: row.state,
  attempts: row.attempts,
  nextRetryAt: row.next_retry_at ?? undefined,
});

const mapMessageRow = (row: RawMessageRow): TelegramMessageRow => ({
  peerKey: row.peer_key,
  messageId: row.message_id,
  senderName: row.sender_name ?? undefined,
  sentAt: row.sent_at,
  text: row.text,
  deletedAt: row.deleted_at ?? undefined,
});

export class TelegramArchiveStore {
  constructor(private readonly db: DatabaseSync) {}

  upsertDialog(dialog: TelegramDialog): void {
    const ts = now();
    this.db
      .prepare(
        `
      INSERT INTO tg_chats(peer_key,kind,title,username,access_hash,selected,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(peer_key) DO UPDATE SET
        kind=excluded.kind,title=excluded.title,username=excluded.username,
        access_hash=excluded.access_hash,updated_at=excluded.updated_at
    `,
      )
      .run(
        dialog.peerKey,
        dialog.kind,
        dialog.title,
        dialog.username ?? null,
        dialog.accessHash ?? null,
        dialog.selected ? 1 : 0,
        ts,
        ts,
      );
  }

  selectChat(peerKey: string, selected: boolean): void {
    this.db
      .prepare(`UPDATE tg_chats SET selected=?,updated_at=? WHERE peer_key=?`)
      .run(selected ? 1 : 0, now(), peerKey);
  }

  getChat(peerKey: string): TelegramChatRow | undefined {
    const row = this.db
      .prepare(
        `SELECT peer_key,kind,title,username,access_hash,selected,last_live_at,
                last_reconciled_at,health_error
         FROM tg_chats WHERE peer_key=?`,
      )
      .get(peerKey) as unknown as RawChatRow | undefined;
    return row ? mapChatRow(row) : undefined;
  }

  /** Carries the access hash so a restarted adapter can address these peers again. */
  listSelectedChats(): TelegramChatRow[] {
    const rows = this.db
      .prepare(
        `SELECT peer_key,kind,title,username,access_hash,selected,last_live_at,
                last_reconciled_at,health_error
         FROM tg_chats WHERE selected=1 ORDER BY title`,
      )
      .all() as unknown as RawChatRow[];
    return rows.map(mapChatRow);
  }

  applyMessages(messages: TelegramMessage[], origin: 'backfill' | 'live' | 'difference'): void {
    this.db.exec('BEGIN');
    try {
      for (const message of messages) this.applyMessage(message, origin);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private applyMessage(message: TelegramMessage, origin: string): void {
    const versionHash = hashVersion(message);
    const ts = now();
    this.db
      .prepare(
        `
      INSERT INTO tg_messages(
        peer_key,message_id,sender_key,sender_name,sent_at,edited_at,
        reply_to_message_id,grouped_id,text,entities_json,reactions_json,
        content_hash,observed_at,triage_pending
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(peer_key,message_id) DO UPDATE SET
        sender_key=excluded.sender_key,sender_name=excluded.sender_name,
        edited_at=excluded.edited_at,reply_to_message_id=excluded.reply_to_message_id,
        grouped_id=excluded.grouped_id,text=excluded.text,
        entities_json=excluded.entities_json,reactions_json=excluded.reactions_json,
        content_hash=excluded.content_hash,observed_at=excluded.observed_at,
        triage_pending=MAX(tg_messages.triage_pending,excluded.triage_pending)
    `,
      )
      .run(
        message.peerKey,
        message.messageId,
        message.senderKey ?? null,
        message.senderName ?? null,
        message.sentAt,
        message.editedAt ?? null,
        message.replyToMessageId ?? null,
        message.groupedId ?? null,
        message.text,
        message.entitiesJson,
        message.reactionsJson,
        versionHash,
        ts,
        origin === 'live' ? 1 : 0,
      );
    this.db
      .prepare(
        `
      INSERT OR IGNORE INTO tg_message_versions(
        peer_key,message_id,version_hash,observed_at,edited_at,text,
        entities_json,reactions_json,poll_json
      ) VALUES(?,?,?,?,?,?,?,?,?)
    `,
      )
      .run(
        message.peerKey,
        message.messageId,
        versionHash,
        ts,
        message.editedAt ?? null,
        message.text,
        message.entitiesJson,
        message.reactionsJson,
        message.poll ? JSON.stringify(message.poll) : null,
      );
    this.writeMessageFts(message.peerKey, message.messageId, message.text);
    this.upsertChildren(message);
    if (origin === 'live') {
      this.db
        .prepare(`UPDATE tg_chats SET last_live_at=?,updated_at=? WHERE peer_key=?`)
        .run(message.sentAt, ts, message.peerKey);
    }
  }

  private upsertChildren(message: TelegramMessage): void {
    const ts = now();
    if (message.senderKey) {
      this.db
        .prepare(
          `
      INSERT INTO tg_participants(peer_key,participant_key,display_name,observed_at)
      VALUES(?,?,?,?)
      ON CONFLICT(peer_key,participant_key) DO UPDATE SET
        display_name=excluded.display_name,observed_at=excluded.observed_at
    `,
        )
        .run(message.peerKey, message.senderKey, message.senderName ?? null, ts);
    }
    for (const media of message.media) {
      this.db
        .prepare(
          `
      INSERT INTO tg_media(
        media_key,peer_key,message_id,kind,filename,mime_type,
        expected_size,descriptor_json,status
      ) VALUES(?,?,?,?,?,?,?,?, 'pending')
      ON CONFLICT(media_key) DO UPDATE SET
        descriptor_json=excluded.descriptor_json,expected_size=excluded.expected_size
    `,
        )
        .run(
          media.mediaKey,
          message.peerKey,
          message.messageId,
          media.kind,
          media.filename ?? null,
          media.mimeType ?? null,
          media.size ?? null,
          media.descriptorJson,
        );
      this.db
        .prepare(
          `
      INSERT OR IGNORE INTO tg_work_items(peer_key,kind,item_key)
      VALUES(?,'media',?)
    `,
        )
        .run(message.peerKey, media.mediaKey);
    }
    for (const link of message.links) {
      const normalized = new URL(link.url).toString();
      this.db
        .prepare(
          `
      INSERT OR IGNORE INTO tg_links(
        peer_key,message_id,original_url,normalized_url,preview_json
      ) VALUES(?,?,?,?,?)
    `,
        )
        .run(message.peerKey, message.messageId, link.url, normalized, link.previewJson ?? null);
      this.db
        .prepare(
          `
      INSERT OR IGNORE INTO tg_work_items(peer_key,kind,item_key)
      VALUES(?,'link',?)
    `,
        )
        .run(message.peerKey, `${message.peerKey}:${message.messageId}:${normalized}`);
    }
  }

  recordHistoryPage(
    peerKey: string,
    messages: TelegramMessage[],
    nextCursor: number | null,
  ): void {
    this.db.exec('BEGIN');
    try {
      for (const message of messages) this.applyMessage(message, 'backfill');
      const ts = now();
      this.db
        .prepare(
          `UPDATE tg_import_jobs SET imported_messages=imported_messages+?,oldest_message_id=?,updated_at=?
           WHERE peer_key=?`,
        )
        .run(messages.length, nextCursor, ts, peerKey);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  createImport(peerKey: string, totalMessages: number): void {
    const ts = now();
    this.db
      .prepare(
        `
      INSERT INTO tg_import_jobs(peer_key,state,total_messages,imported_messages,started_at,updated_at)
      VALUES(?,'acquiring',?,0,?,?)
      ON CONFLICT(peer_key) DO UPDATE SET
        state='acquiring',total_messages=excluded.total_messages,imported_messages=0,
        oldest_message_id=NULL,next_retry_at=NULL,last_error=NULL,completed_at=NULL,
        started_at=excluded.started_at,updated_at=excluded.updated_at
    `,
      )
      .run(peerKey, totalMessages, ts, ts);
  }

  getImport(peerKey: string): TelegramImportRow | undefined {
    const row = this.db
      .prepare(`SELECT * FROM tg_import_jobs WHERE peer_key=?`)
      .get(peerKey) as unknown as RawImportRow | undefined;
    return row ? mapImportRow(row) : undefined;
  }

  claimImport(at: string): TelegramImportRow | undefined {
    const row = this.db
      .prepare(
        `
      SELECT * FROM tg_import_jobs
      WHERE state IN ('scanning','acquiring') AND (next_retry_at IS NULL OR next_retry_at<=?)
      ORDER BY started_at LIMIT 1
    `,
      )
      .get(at) as unknown as RawImportRow | undefined;
    return row ? mapImportRow(row) : undefined;
  }

  setImportState(peerKey: string, state: TelegramImportState, error?: string): void {
    const ts = now();
    this.db
      .prepare(
        `
      UPDATE tg_import_jobs SET state=?,last_error=?,
        completed_at=CASE WHEN ?='complete' THEN ? ELSE completed_at END,
        updated_at=?
      WHERE peer_key=?
    `,
      )
      .run(state, error ?? null, state, ts, ts, peerKey);
  }

  /** Records a retry without changing the phase, so the cursor survives the wait. */
  deferImport(peerKey: string, error: string, retryAt: string): void {
    this.db
      .prepare(
        `UPDATE tg_import_jobs SET next_retry_at=?,last_error=?,updated_at=? WHERE peer_key=?`,
      )
      .run(retryAt, error, now(), peerKey);
  }

  clearImportRetry(peerKey: string): void {
    this.db
      .prepare(
        `UPDATE tg_import_jobs SET next_retry_at=NULL,last_error=NULL,updated_at=?
         WHERE peer_key=? AND (next_retry_at IS NOT NULL OR last_error IS NOT NULL)`,
      )
      .run(now(), peerKey);
  }

  pauseImport(peerKey: string): boolean {
    return this.changed(
      `UPDATE tg_import_jobs SET state='paused',updated_at=?
       WHERE peer_key=? AND state IN ('scanning','acquiring')`,
      now(),
      peerKey,
    );
  }

  /**
   * A finished scan leaves imported messages behind and no cursor, which is how a resumed
   * job knows to go straight back to acquisition instead of re-walking the whole history.
   */
  resumeImport(peerKey: string): boolean {
    return this.changed(
      `UPDATE tg_import_jobs
       SET state=CASE WHEN imported_messages>0 AND oldest_message_id IS NULL
                      THEN 'acquiring' ELSE 'scanning' END,
           next_retry_at=NULL,last_error=NULL,updated_at=?
       WHERE peer_key=? AND state IN ('paused','error')`,
      now(),
      peerKey,
    );
  }

  /** Stops future work only. Imported rows, blobs, and queue history are all preserved. */
  cancelImport(peerKey: string): boolean {
    return this.changed(
      `UPDATE tg_import_jobs SET state='cancelled',updated_at=?
       WHERE peer_key=? AND state NOT IN ('complete','cancelled')`,
      now(),
      peerKey,
    );
  }

  /** Re-queues this chat's failed and paused acquisition work with a fresh retry budget. */
  retryFailedWork(peerKey: string): number {
    this.db.exec('BEGIN');
    try {
      const result = this.db
        .prepare(
          `UPDATE tg_work_items SET state='pending',attempts=0,next_retry_at=NULL,last_error=NULL
           WHERE peer_key=? AND state IN ('failed','paused')`,
        )
        .run(peerKey);
      this.db
        .prepare(
          `UPDATE tg_media SET status='pending',error=NULL,retry_at=NULL
           WHERE peer_key=? AND status IN ('failed','paused')`,
        )
        .run(peerKey);
      const requeued = Number(result.changes);
      // A finished import that owes work again is not finished; reopen it so the lane can
      // complete it a second time once the queue drains.
      if (requeued > 0) {
        this.db
          .prepare(
            `UPDATE tg_import_jobs SET state='acquiring',completed_at=NULL,updated_at=?
             WHERE peer_key=? AND state='complete'`,
          )
          .run(now(), peerKey);
      }
      this.db.exec('COMMIT');
      return requeued;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Completes an import once its queue is drained. Imported counts are never compared with
   * the Telegram total: service messages the adapter filters keep that total out of reach.
   */
  completeImport(peerKey: string, at: string): boolean {
    return this.changed(
      `UPDATE tg_import_jobs SET state='complete',completed_at=?,updated_at=?
       WHERE peer_key=? AND state='acquiring'
         AND NOT EXISTS (
           SELECT 1 FROM tg_work_items w
           WHERE w.peer_key=tg_import_jobs.peer_key AND w.state IN ${OPEN_WORK_STATES}
         )`,
      at,
      at,
      peerKey,
    );
  }

  getImportSummary(peerKey: string): TelegramImportSummary | undefined {
    const job = this.getImport(peerKey);
    if (!job) return undefined;
    const counters = this.db
      .prepare(
        `SELECT downloaded_media_bytes AS bytes,failed_media AS media,failed_links AS links
         FROM tg_import_jobs WHERE peer_key=?`,
      )
      .get(peerKey) as unknown as { bytes: number; media: number; links: number };
    const snapshots = this.db
      .prepare(`SELECT COUNT(1) AS n FROM tg_links WHERE peer_key=? AND status='complete'`)
      .get(peerKey) as unknown as { n: number };
    return {
      title: this.getChat(peerKey)?.title ?? peerKey,
      importedMessages: job.importedMessages,
      totalMessages: job.totalMessages,
      downloadedMediaBytes: counters.bytes,
      linkSnapshots: snapshots.n,
      failedMedia: counters.media,
      failedLinks: counters.links,
    };
  }

  completeReadyImports(at: string): void {
    this.db
      .prepare(
        `
      UPDATE tg_import_jobs SET state='complete',completed_at=?,updated_at=?
      WHERE state='acquiring' AND total_messages IS NOT NULL AND imported_messages>=total_messages
    `,
      )
      .run(at, at);
  }

  claimWorkItem(at: string): TelegramWorkItem | undefined {
    this.db.exec('BEGIN');
    try {
      const row = this.db
        .prepare(
          `
        SELECT * FROM tg_work_items
        WHERE state IN ('pending','retry') AND (next_retry_at IS NULL OR next_retry_at<=?)
          AND NOT EXISTS (
            SELECT 1 FROM tg_import_jobs j
            WHERE j.peer_key=tg_work_items.peer_key AND j.state IN ('paused','cancelled')
          )
        ORDER BY id LIMIT 1
      `,
        )
        .get(at) as unknown as RawWorkItemRow | undefined;
      if (!row) {
        this.db.exec('COMMIT');
        return undefined;
      }
      this.db.prepare(`UPDATE tg_work_items SET state='in_progress' WHERE id=?`).run(row.id);
      this.db.exec('COMMIT');
      return mapWorkItem({ ...row, state: 'in_progress' });
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  completeWorkItem(id: number): void {
    this.db.prepare(`UPDATE tg_work_items SET state='done' WHERE id=?`).run(id);
  }

  failWorkItem(id: number, error: string, retryAt?: string): void {
    this.db
      .prepare(
        `UPDATE tg_work_items SET state=?,attempts=attempts+1,last_error=?,next_retry_at=? WHERE id=?`,
      )
      .run(retryAt ? 'pending' : 'failed', error, retryAt ?? null, id);
  }

  /**
   * Waits out a server-imposed delay. Telegram pacing us is not the item misbehaving, so the
   * attempt count — and with it the bounded retry budget — is left alone.
   */
  deferWorkItem(id: number, error: string, retryAt: string): void {
    this.db
      .prepare(`UPDATE tg_work_items SET state='retry',last_error=?,next_retry_at=? WHERE id=?`)
      .run(error, retryAt, id);
  }

  pauseWorkItem(
    id: number,
    error: string,
    options: { lowDisk?: boolean; retryAt?: string } = {},
  ): void {
    this.db
      .prepare(`UPDATE tg_work_items SET state='paused',last_error=?,next_retry_at=? WHERE id=?`)
      .run(
        options.lowDisk ? `${LOW_DISK_PREFIX}${error}` : error,
        options.retryAt ?? null,
        id,
      );
  }

  /** Lifts only the lane's own low-disk pauses; storage faults stay paused for a human. */
  resumeLowDiskWork(at: string): number {
    // The lane asks this every cycle, so stay a pure read until there is something to lift.
    const paused = this.db.prepare(`SELECT 1 FROM tg_work_items WHERE state='paused' LIMIT 1`).get();
    if (!paused) return 0;
    this.db.exec('BEGIN');
    try {
      const result = this.db
        .prepare(
          `UPDATE tg_work_items SET state='pending',next_retry_at=NULL
           WHERE state='paused' AND last_error LIKE ?
             AND (next_retry_at IS NULL OR next_retry_at<=?)`,
        )
        .run(`${LOW_DISK_PREFIX}%`, at);
      const resumed = Number(result.changes);
      if (resumed > 0) {
        this.db
          .prepare(
            `UPDATE tg_media SET status='pending',retry_at=NULL
             WHERE status='paused' AND media_key IN (
               SELECT item_key FROM tg_work_items WHERE kind='media' AND state='pending'
             )`,
          )
          .run();
      }
      this.db.exec('COMMIT');
      return resumed;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getMediaTarget(mediaKey: string): TelegramMediaTarget | undefined {
    const row = this.db
      .prepare(
        `SELECT media_key,peer_key,message_id,expected_size,status,blob_hash
         FROM tg_media WHERE media_key=?`,
      )
      .get(mediaKey) as unknown as
      | {
          media_key: string;
          peer_key: string;
          message_id: number;
          expected_size: number | null;
          status: string;
          blob_hash: string | null;
        }
      | undefined;
    if (!row) return undefined;
    return {
      mediaKey: row.media_key,
      peerKey: row.peer_key,
      messageId: row.message_id,
      expectedSize: row.expected_size ?? undefined,
      status: row.status,
      blobHash: row.blob_hash ?? undefined,
    };
  }

  completeMediaWork(input: {
    workItemId: number;
    mediaKey: string;
    peerKey: string;
    blobHash: string;
    bytes: number;
  }): void {
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `UPDATE tg_media SET blob_hash=?,bytes=?,status='done',error=NULL,retry_at=NULL
           WHERE media_key=?`,
        )
        .run(input.blobHash, input.bytes, input.mediaKey);
      this.db
        .prepare(`UPDATE tg_work_items SET state='done',last_error=NULL,next_retry_at=NULL WHERE id=?`)
        .run(input.workItemId);
      this.db
        .prepare(
          `UPDATE tg_import_jobs SET downloaded_media_bytes=downloaded_media_bytes+?,updated_at=?
           WHERE peer_key=?`,
        )
        .run(input.bytes, now(), input.peerKey);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Keeps the queue entry and its media row on the same verdict. */
  recordMediaFailure(input: {
    workItemId: number;
    mediaKey: string;
    peerKey: string;
    error: string;
    disposition: 'flood' | 'backoff' | 'storage' | 'low_disk' | 'failed';
    retryAt?: string;
  }): void {
    this.db.exec('BEGIN');
    try {
      if (input.disposition === 'flood' && input.retryAt) {
        this.deferWorkItem(input.workItemId, input.error, input.retryAt);
      } else if (input.disposition === 'flood' || input.disposition === 'backoff') {
        this.failWorkItem(input.workItemId, input.error, input.retryAt);
      } else if (input.disposition === 'failed') {
        this.failWorkItem(input.workItemId, input.error);
      } else {
        this.pauseWorkItem(input.workItemId, input.error, {
          lowDisk: input.disposition === 'low_disk',
          retryAt: input.retryAt,
        });
      }
      const status =
        input.disposition === 'failed'
          ? 'failed'
          : input.disposition === 'storage' || input.disposition === 'low_disk'
            ? 'paused'
            : 'pending';
      this.db
        .prepare(`UPDATE tg_media SET status=?,error=?,retry_at=? WHERE media_key=?`)
        .run(status, input.error, input.retryAt ?? null, input.mediaKey);
      if (input.disposition === 'failed') {
        this.db
          .prepare(
            `UPDATE tg_import_jobs SET failed_media=failed_media+1,updated_at=? WHERE peer_key=?`,
          )
          .run(now(), input.peerKey);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Resolves the `peerKey:messageId:normalizedUrl` queue key back to its link row. */
  getLinkTarget(peerKey: string, itemKey: string): TelegramLinkTarget | undefined {
    const prefix = `${peerKey}:`;
    if (!itemKey.startsWith(prefix)) return undefined;
    const rest = itemKey.slice(prefix.length);
    const separator = rest.indexOf(':');
    if (separator < 0) return undefined;
    const messageId = Number(rest.slice(0, separator));
    if (!Number.isInteger(messageId)) return undefined;
    const normalizedUrl = rest.slice(separator + 1);
    const row = this.db
      .prepare(
        `SELECT id,original_url,status FROM tg_links
         WHERE peer_key=? AND message_id=? AND normalized_url=?`,
      )
      .get(peerKey, messageId, normalizedUrl) as unknown as
      | { id: number; original_url: string; status: string }
      | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      peerKey,
      messageId,
      url: row.original_url,
      normalizedUrl,
      status: row.status,
    };
  }

  completeLinkWork(input: {
    workItemId: number;
    linkId: number;
    peerKey: string;
    messageId: number;
    fetchedAt: string;
    result:
      | {
          status: 'complete';
          finalUrl: string;
          responseJson: string;
          snapshotHash: string;
          text: string;
        }
      | { status: 'unavailable'; finalUrl?: string; error: string };
  }): void {
    const { result } = input;
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `UPDATE tg_links SET final_url=?,response_json=?,snapshot_hash=?,extracted_text=?,
             status=?,error=?,fetched_at=? WHERE id=?`,
        )
        .run(
          result.finalUrl ?? null,
          result.status === 'complete' ? result.responseJson : null,
          result.status === 'complete' ? result.snapshotHash : null,
          result.status === 'complete' ? result.text : null,
          result.status,
          result.status === 'unavailable' ? result.error : null,
          input.fetchedAt,
          input.linkId,
        );
      this.reindexMessageLinks(input.peerKey, input.messageId);
      this.completeWorkItem(input.workItemId);
      if (result.status === 'unavailable') {
        this.db
          .prepare(
            `UPDATE tg_import_jobs SET failed_links=failed_links+1,updated_at=? WHERE peer_key=?`,
          )
          .run(now(), input.peerKey);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private reindexMessageLinks(peerKey: string, messageId: number): void {
    const message = this.db
      .prepare(`SELECT text FROM tg_messages WHERE peer_key=? AND message_id=?`)
      .get(peerKey, messageId) as unknown as { text: string } | undefined;
    if (message) this.writeMessageFts(peerKey, messageId, message.text);
  }

  /**
   * Rewrites the search row from the message text plus whatever link snapshots are stored,
   * so an edit or a reaction cannot silently drop link text from the index.
   */
  private writeMessageFts(peerKey: string, messageId: number, text: string): void {
    const links = this.db
      .prepare(
        `SELECT COALESCE(GROUP_CONCAT(extracted_text,' '),'') AS text FROM tg_links
         WHERE peer_key=? AND message_id=? AND extracted_text IS NOT NULL`,
      )
      .get(peerKey, messageId) as unknown as { text: string };
    this.db
      .prepare(`DELETE FROM tg_message_fts WHERE peer_key=? AND message_id=?`)
      .run(peerKey, messageId);
    this.db
      .prepare(`INSERT INTO tg_message_fts(peer_key,message_id,text,link_text) VALUES(?,?,?,?)`)
      .run(peerKey, messageId, text, links.text);
  }

  private changed(sql: string, ...params: (string | number)[]): boolean {
    return Number(this.db.prepare(sql).run(...params).changes) > 0;
  }

  markDeleted(peerKey: string | undefined, messageIds: number[], observedAt: string): void {
    if (messageIds.length === 0) return;
    const placeholders = messageIds.map(() => '?').join(',');
    if (peerKey) {
      this.db
        .prepare(
          `UPDATE tg_messages SET deleted_at=? WHERE peer_key=? AND message_id IN (${placeholders})`,
        )
        .run(observedAt, peerKey, ...messageIds);
    } else {
      this.db
        .prepare(`UPDATE tg_messages SET deleted_at=? WHERE message_id IN (${placeholders})`)
        .run(observedAt, ...messageIds);
    }
  }

  private getLatestPollJson(peerKey: string, messageId: number): string | null {
    const row = this.db
      .prepare(
        `SELECT poll_json FROM tg_message_versions
         WHERE peer_key=? AND message_id=? AND poll_json IS NOT NULL
         ORDER BY rowid DESC LIMIT 1`,
      )
      .get(peerKey, messageId) as unknown as { poll_json: string } | undefined;
    return row?.poll_json ?? null;
  }

  private applyVersion(
    peerKey: string,
    messageId: number,
    snapshot: {
      editedAt?: string;
      text: string;
      entitiesJson: string;
      reactionsJson: string;
      pollJson: string | null;
    },
    observedAt: string,
  ): void {
    const hash = computeVersionHash({
      text: snapshot.text,
      editedAt: snapshot.editedAt,
      entitiesJson: snapshot.entitiesJson,
      reactionsJson: snapshot.reactionsJson,
      poll: snapshot.pollJson ? (JSON.parse(snapshot.pollJson) as TelegramPollSnapshot) : null,
    });
    this.db
      .prepare(
        `
      INSERT OR IGNORE INTO tg_message_versions(
        peer_key,message_id,version_hash,observed_at,edited_at,text,
        entities_json,reactions_json,poll_json
      ) VALUES(?,?,?,?,?,?,?,?,?)
    `,
      )
      .run(
        peerKey,
        messageId,
        hash,
        observedAt,
        snapshot.editedAt ?? null,
        snapshot.text,
        snapshot.entitiesJson,
        snapshot.reactionsJson,
        snapshot.pollJson,
      );
    this.db
      .prepare(
        `
      UPDATE tg_messages SET edited_at=?,text=?,entities_json=?,reactions_json=?,
        content_hash=?,observed_at=?
      WHERE peer_key=? AND message_id=?
    `,
      )
      .run(
        snapshot.editedAt ?? null,
        snapshot.text,
        snapshot.entitiesJson,
        snapshot.reactionsJson,
        hash,
        observedAt,
        peerKey,
        messageId,
      );
    this.writeMessageFts(peerKey, messageId, snapshot.text);
  }

  replaceReactions(peerKey: string, messageId: number, json: string, observedAt: string): void {
    const row = this.db
      .prepare(`SELECT text,entities_json,edited_at FROM tg_messages WHERE peer_key=? AND message_id=?`)
      .get(peerKey, messageId) as unknown as
      | { text: string; entities_json: string; edited_at: string | null }
      | undefined;
    if (!row) return;
    this.applyVersion(
      peerKey,
      messageId,
      {
        editedAt: row.edited_at ?? undefined,
        text: row.text,
        entitiesJson: row.entities_json,
        reactionsJson: json,
        pollJson: this.getLatestPollJson(peerKey, messageId),
      },
      observedAt,
    );
  }

  replacePoll(
    peerKey: string,
    messageId: number,
    poll: TelegramPollSnapshot,
    observedAt: string,
  ): void {
    const row = this.db
      .prepare(
        `SELECT text,entities_json,reactions_json,edited_at FROM tg_messages
         WHERE peer_key=? AND message_id=?`,
      )
      .get(peerKey, messageId) as unknown as
      | { text: string; entities_json: string; reactions_json: string; edited_at: string | null }
      | undefined;
    if (!row) return;
    this.applyVersion(
      peerKey,
      messageId,
      {
        editedAt: row.edited_at ?? undefined,
        text: row.text,
        entitiesJson: row.entities_json,
        reactionsJson: row.reactions_json,
        pollJson: JSON.stringify(poll),
      },
      observedAt,
    );
  }

  getUpdateState(stateKey: string): string | undefined {
    const row = this.db
      .prepare(`SELECT value FROM tg_update_state WHERE state_key=?`)
      .get(stateKey) as unknown as { value: string } | undefined;
    return row?.value;
  }

  setUpdateState(stateKey: string, value: string, verifiedAt?: string): void {
    const ts = now();
    this.db
      .prepare(
        `
      INSERT INTO tg_update_state(state_key,value,verified_at,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(state_key) DO UPDATE SET
        value=excluded.value,
        verified_at=COALESCE(excluded.verified_at,tg_update_state.verified_at),
        updated_at=excluded.updated_at
    `,
      )
      .run(stateKey, value, verifiedAt ?? null, ts);
  }

  getUntriagedRange(peerKey: string): { fromId: number; throughId: number } | undefined {
    const row = this.db
      .prepare(
        `SELECT MIN(message_id) AS fromId,MAX(message_id) AS throughId,COUNT(1) AS n
         FROM tg_messages WHERE peer_key=? AND triage_pending=1`,
      )
      .get(peerKey) as unknown as { fromId: number | null; throughId: number | null; n: number };
    return row.n > 0 ? { fromId: row.fromId as number, throughId: row.throughId as number } : undefined;
  }

  loadTriageWindow(peerKey: string, throughId: number, limit: number): TelegramMessageRow[] {
    const rows = this.db
      .prepare(
        `SELECT peer_key,message_id,sender_name,sent_at,text,deleted_at
         FROM tg_messages WHERE peer_key=? AND message_id<=?
         ORDER BY message_id DESC LIMIT ?`,
      )
      .all(peerKey, throughId, limit) as unknown as RawMessageRow[];
    return rows.map(mapMessageRow).reverse();
  }

  markTriageEligible(peerKey: string, messageId: number): void {
    this.db
      .prepare(`UPDATE tg_messages SET triage_pending=1 WHERE peer_key=? AND message_id=?`)
      .run(peerKey, messageId);
  }

  markTriagedThrough(peerKey: string, throughId: number, at: string): void {
    this.db
      .prepare(
        `UPDATE tg_messages SET triage_pending=0,triaged_at=?
         WHERE peer_key=? AND message_id<=? AND triage_pending=1`,
      )
      .run(at, peerKey, throughId);
  }

  recordTriageResult(peerKey: string, throughId: number, result: TurnResult): void {
    const key = `triage:${peerKey}`;
    const prevRow = this.db
      .prepare(`SELECT value FROM tg_update_state WHERE state_key=?`)
      .get(key) as unknown as { value: string } | undefined;
    const prev = prevRow
      ? (JSON.parse(prevRow.value) as { consecutiveFailures: number; alerted?: boolean })
      : { consecutiveFailures: 0, alerted: false };
    // An ongoing error streak keeps its `alerted` flag so shouldAlertTriageFailure only
    // fires once per streak; only a non-error result clears it for the next streak.
    const consecutiveFailures = result.status === 'error' ? prev.consecutiveFailures + 1 : 0;
    const alerted = result.status === 'error' ? (prev.alerted ?? false) : false;
    const value = JSON.stringify({
      throughId,
      status: result.status,
      error: result.error,
      consecutiveFailures,
      alerted,
    });
    const ts = now();
    this.db
      .prepare(
        `
      INSERT INTO tg_update_state(state_key,value,updated_at) VALUES(?,?,?)
      ON CONFLICT(state_key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at
    `,
      )
      .run(key, value, ts);
  }

  shouldAlertTriageFailure(peerKey: string, throughId: number): boolean {
    const key = `triage:${peerKey}`;
    const row = this.db
      .prepare(`SELECT value FROM tg_update_state WHERE state_key=?`)
      .get(key) as unknown as { value: string } | undefined;
    if (!row) return false;
    const state = JSON.parse(row.value) as {
      throughId: number;
      consecutiveFailures: number;
      alerted: boolean;
    };
    if (
      state.throughId !== throughId ||
      state.consecutiveFailures < TRIAGE_FAILURE_ALERT_THRESHOLD ||
      state.alerted
    ) {
      return false;
    }
    this.db
      .prepare(`UPDATE tg_update_state SET value=?,updated_at=? WHERE state_key=?`)
      .run(JSON.stringify({ ...state, alerted: true }), now(), key);
    return true;
  }

  getMessage(peerKey: string, messageId: number): TelegramMessageRow | undefined {
    const row = this.db
      .prepare(
        `SELECT peer_key,message_id,sender_name,sent_at,text,deleted_at
         FROM tg_messages WHERE peer_key=? AND message_id=?`,
      )
      .get(peerKey, messageId) as unknown as RawMessageRow | undefined;
    return row ? mapMessageRow(row) : undefined;
  }

  setHealth(state: TelegramHealthState, error?: string): void {
    const ts = now();
    this.db
      .prepare(
        `
      INSERT INTO tg_update_state(state_key,value,updated_at) VALUES('health',?,?)
      ON CONFLICT(state_key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at
    `,
      )
      .run(JSON.stringify({ state, error }), ts);
  }

  getHealth(): TelegramHealth {
    const stored = this.db
      .prepare(`SELECT value FROM tg_update_state WHERE state_key='health'`)
      .get() as unknown as { value: string } | undefined;
    const parsed = stored
      ? (JSON.parse(stored.value) as { state: TelegramHealthState; error?: string })
      : { state: 'not_configured' as TelegramHealthState, error: undefined };
    const selected = this.db
      .prepare(`SELECT COUNT(1) AS n FROM tg_chats WHERE selected=1`)
      .get() as unknown as { n: number };
    const active = this.db
      .prepare(
        `
      SELECT c.title AS title, j.imported_messages AS imported, j.total_messages AS total
      FROM tg_import_jobs j JOIN tg_chats c ON c.peer_key=j.peer_key
      WHERE j.state IN ('scanning','acquiring')
      ORDER BY j.started_at LIMIT 1
    `,
      )
      .get() as unknown as { title: string; imported: number; total: number | null } | undefined;
    const timestamps = this.db
      .prepare(
        `SELECT MAX(last_live_at) AS lastLiveAt,MAX(last_reconciled_at) AS lastReconciledAt
         FROM tg_chats WHERE selected=1`,
      )
      .get() as unknown as { lastLiveAt: string | null; lastReconciledAt: string | null };
    return {
      state: parsed.state,
      selectedChats: selected.n,
      activeChatTitle: active?.title,
      importedMessages: active?.imported,
      totalMessages: active?.total ?? undefined,
      lastLiveAt: timestamps.lastLiveAt ?? undefined,
      lastReconciledAt: timestamps.lastReconciledAt ?? undefined,
      error: parsed.error,
    };
  }

  removeChatArchive(peerKey: string): string[] {
    this.db.exec('BEGIN');
    try {
      const mediaHashes = (
        this.db
          .prepare(`SELECT DISTINCT blob_hash FROM tg_media WHERE peer_key=? AND blob_hash IS NOT NULL`)
          .all(peerKey) as unknown as { blob_hash: string }[]
      ).map((r) => r.blob_hash);
      const linkHashes = (
        this.db
          .prepare(
            `SELECT DISTINCT snapshot_hash FROM tg_links WHERE peer_key=? AND snapshot_hash IS NOT NULL`,
          )
          .all(peerKey) as unknown as { snapshot_hash: string }[]
      ).map((r) => r.snapshot_hash);
      const candidates = Array.from(new Set([...mediaHashes, ...linkHashes]));
      this.db.prepare(`DELETE FROM tg_chats WHERE peer_key=?`).run(peerKey);
      const orphaned = candidates.filter((hash) => {
        const usedByMedia = this.db.prepare(`SELECT 1 FROM tg_media WHERE blob_hash=? LIMIT 1`).get(hash);
        const usedByLink = this.db
          .prepare(`SELECT 1 FROM tg_links WHERE snapshot_hash=? LIMIT 1`)
          .get(hash);
        return !usedByMedia && !usedByLink;
      });
      this.db.exec('COMMIT');
      return orphaned;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
