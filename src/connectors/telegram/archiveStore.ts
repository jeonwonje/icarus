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
  selected: boolean;
  lastLiveAt?: string;
  lastReconciledAt?: string;
  healthError?: string;
}

interface RawChatRow {
  peer_key: string;
  kind: TelegramPeerKind;
  title: string;
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
        `SELECT peer_key,kind,title,selected,last_live_at,last_reconciled_at,health_error
         FROM tg_chats WHERE peer_key=?`,
      )
      .get(peerKey) as unknown as RawChatRow | undefined;
    return row ? mapChatRow(row) : undefined;
  }

  listSelectedChats(): TelegramChatRow[] {
    const rows = this.db
      .prepare(
        `SELECT peer_key,kind,title,selected,last_live_at,last_reconciled_at,health_error
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
    this.db
      .prepare(`DELETE FROM tg_message_fts WHERE peer_key=? AND message_id=?`)
      .run(message.peerKey, message.messageId);
    this.db
      .prepare(
        `INSERT INTO tg_message_fts(peer_key,message_id,text,link_text)
                     VALUES(?,?,?,'')`,
      )
      .run(message.peerKey, message.messageId, message.text);
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
        WHERE state='pending' AND (next_retry_at IS NULL OR next_retry_at<=?)
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
    this.db
      .prepare(`DELETE FROM tg_message_fts WHERE peer_key=? AND message_id=?`)
      .run(peerKey, messageId);
    this.db
      .prepare(`INSERT INTO tg_message_fts(peer_key,message_id,text,link_text) VALUES(?,?,?,'')`)
      .run(peerKey, messageId, snapshot.text);
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
