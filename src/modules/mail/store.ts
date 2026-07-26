import type { DatabaseSync } from 'node:sqlite';

/** Every mail SQL statement and every `as unknown as T` cast lives here. */

export type MailExportState = 'census' | 'ranking' | 'triaging' | 'done' | 'paused' | 'error';

export type MailMessageState =
  | 'new'
  | 'ranking'
  | 'ranked'
  | 'queued'
  | 'triaged'
  | 'skipped'
  | 'rank_failed'
  | 'triage_failed'
  | 'materialize_failed';

export type SenderVerdict = 'relevant' | 'sometimes' | 'noise';

export interface MailExportRow {
  id: number;
  fileSig: string;
  fileName: string;
  filePath: string;
  bytes: number;
  state: MailExportState;
  cursorJson: string | null;
  totalMessages: number | null;
  scannedMessages: number;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface MailMessageRow {
  id: number;
  exportId: number;
  messageKey: string;
  folderPath: string;
  folderName: string;
  childIndex: number;
  sentAt: string | null;
  senderName: string;
  senderEmail: string;
  recipients: string;
  subject: string;
  attachmentCount: number;
  mdPath: string | null;
  attDir: string | null;
  state: MailMessageState;
  rank: number | null;
  rankReason: string | null;
  rankSource: string | null;
  attempts: number;
}

export interface MailSenderRow {
  id: number;
  email: string;
  displayName: string;
  verdict: SenderVerdict;
  why: string;
  source: 'model' | 'owner';
  active: number;
  hits: number;
}

export interface MailFiledRow {
  id: number;
  messageId: number;
  kind: 'attachment' | 'document';
  project: string;
  displayName: string;
  destPath: string;
  reused: number;
  why: string;
  filedAt: string;
}

export interface MailLinkRow {
  id: number;
  messageId: number;
  url: string;
  title: string;
  project: string;
  why: string;
  recordedAt: string;
}

export interface CensusMessageInput {
  messageKey: string;
  folderPath: string;
  folderName: string;
  childIndex: number;
  sentAt: string | null;
  senderName: string;
  senderEmail: string;
  recipients: string;
  subject: string;
  attachmentCount: number;
}

const EXPORT_COLS = `id, file_sig AS fileSig, file_name AS fileName, file_path AS filePath,
  bytes, state, cursor_json AS cursorJson, total_messages AS totalMessages,
  scanned_messages AS scannedMessages, attempts, last_error AS lastError,
  created_at AS createdAt, updated_at AS updatedAt, completed_at AS completedAt`;

const MESSAGE_COLS = `id, export_id AS exportId, message_key AS messageKey,
  folder_path AS folderPath, folder_name AS folderName, child_index AS childIndex,
  sent_at AS sentAt, sender_name AS senderName, sender_email AS senderEmail,
  recipients, subject, attachment_count AS attachmentCount, md_path AS mdPath,
  att_dir AS attDir, state, rank, rank_reason AS rankReason, rank_source AS rankSource, attempts`;

const SENDER_COLS = `id, email, display_name AS displayName, verdict, why, source, active, hits`;

export class MailStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  // -- exports ---------------------------------------------------------------

  getExportBySig(fileSig: string): MailExportRow | undefined {
    return this.db.prepare(`SELECT ${EXPORT_COLS} FROM mail_exports WHERE file_sig=?`).get(fileSig) as
      | unknown as MailExportRow | undefined;
  }

  getExport(id: number): MailExportRow | undefined {
    return this.db.prepare(`SELECT ${EXPORT_COLS} FROM mail_exports WHERE id=?`).get(id) as
      | unknown as MailExportRow | undefined;
  }

  createExport(input: { fileSig: string; fileName: string; filePath: string; bytes: number }): MailExportRow {
    const ts = this.clock();
    this.db
      .prepare(
        `INSERT INTO mail_exports(file_sig,file_name,file_path,bytes,state,created_at,updated_at)
         VALUES(?,?,?,?,'census',?,?)`,
      )
      .run(input.fileSig, input.fileName, input.filePath, input.bytes, ts, ts);
    return this.getExportBySig(input.fileSig)!;
  }

  /** Exports still carrying work, oldest first. */
  activeExports(): MailExportRow[] {
    return this.db
      .prepare(
        `SELECT ${EXPORT_COLS} FROM mail_exports
         WHERE state IN ('census','ranking','triaging') ORDER BY id`,
      )
      .all() as unknown as MailExportRow[];
  }

  listExports(limit = 10): MailExportRow[] {
    return this.db
      .prepare(`SELECT ${EXPORT_COLS} FROM mail_exports ORDER BY id DESC LIMIT ?`)
      .all(limit) as unknown as MailExportRow[];
  }

  setExportState(id: number, state: MailExportState, extra: { lastError?: string | null } = {}): void {
    const ts = this.clock();
    this.db
      .prepare(
        `UPDATE mail_exports SET state=?, updated_at=?,
           last_error=COALESCE(?, last_error),
           completed_at=CASE WHEN ?='done' THEN ? ELSE completed_at END
         WHERE id=?`,
      )
      .run(state, ts, extra.lastError ?? null, state, ts, id);
  }

  saveCursor(id: number, cursorJson: string | null, scannedMessages: number): void {
    this.db
      .prepare('UPDATE mail_exports SET cursor_json=?, scanned_messages=?, updated_at=? WHERE id=?')
      .run(cursorJson, scannedMessages, this.clock(), id);
  }

  setTotalMessages(id: number, total: number): void {
    this.db
      .prepare('UPDATE mail_exports SET total_messages=?, updated_at=? WHERE id=?')
      .run(total, this.clock(), id);
  }

  bumpExportAttempts(id: number, lastError: string): number {
    this.db
      .prepare('UPDATE mail_exports SET attempts=attempts+1, last_error=?, updated_at=? WHERE id=?')
      .run(lastError.slice(0, 500), this.clock(), id);
    return this.getExport(id)?.attempts ?? 0;
  }

  clearExportAttempts(id: number): void {
    this.db
      .prepare('UPDATE mail_exports SET attempts=0, last_error=NULL, updated_at=? WHERE id=?')
      .run(this.clock(), id);
  }

  // -- messages --------------------------------------------------------------

  /** Batch insert, synchronous by design — never call this with an await inside the loop. */
  insertMessages(exportId: number, rows: CensusMessageInput[]): number {
    if (rows.length === 0) return 0;
    const ts = this.clock();
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO mail_messages(
         export_id,message_key,folder_path,folder_name,child_index,sent_at,
         sender_name,sender_email,recipients,subject,attachment_count,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    let inserted = 0;
    this.db.exec('BEGIN');
    try {
      for (const r of rows) {
        const res = stmt.run(
          exportId,
          r.messageKey,
          r.folderPath,
          r.folderName,
          r.childIndex,
          r.sentAt,
          r.senderName,
          r.senderEmail,
          r.recipients,
          r.subject,
          r.attachmentCount,
          ts,
          ts,
        );
        inserted += Number(res.changes);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return inserted;
  }

  getMessage(id: number): MailMessageRow | undefined {
    return this.db.prepare(`SELECT ${MESSAGE_COLS} FROM mail_messages WHERE id=?`).get(id) as
      | unknown as MailMessageRow | undefined;
  }

  countByState(exportId: number, state: MailMessageState): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM mail_messages WHERE export_id=? AND state=?')
      .get(exportId, state) as unknown as { n: number };
    return row.n;
  }

  /** Backlog counters for /mail and the digest. */
  counts(): { toRank: number; toRead: number; setAside: number; filed: number } {
    const one = (sql: string, ...args: unknown[]): number =>
      (this.db.prepare(sql).get(...(args as never[])) as unknown as { n: number }).n;
    return {
      toRank: one(`SELECT COUNT(*) AS n FROM mail_messages WHERE state IN ('new','ranking')`),
      toRead: one(`SELECT COUNT(*) AS n FROM mail_messages WHERE state IN ('ranked','queued')`),
      setAside: one(`SELECT COUNT(*) AS n FROM mail_messages WHERE state='skipped'`),
      filed: one('SELECT COUNT(*) AS n FROM mail_filed'),
    };
  }

  /** Distinct senders with unranked mail and no active verdict yet. */
  claimSendersForVerdict(limit: number): { email: string; displayName: string; n: number; subjects: string[] }[] {
    const rows = this.db
      .prepare(
        `SELECT m.sender_email AS email, MIN(m.sender_name) AS displayName, COUNT(*) AS n
           FROM mail_messages m
           LEFT JOIN mail_senders s ON s.email = m.sender_email AND s.active = 1
          WHERE m.state='new' AND s.id IS NULL AND m.sender_email <> ''
          GROUP BY m.sender_email
          ORDER BY n DESC
          LIMIT ?`,
      )
      .all(limit) as unknown as { email: string; displayName: string; n: number }[];
    const subjStmt = this.db.prepare(
      `SELECT subject FROM mail_messages
        WHERE sender_email=? AND state='new' AND subject <> ''
        ORDER BY sent_at DESC LIMIT 5`,
    );
    return rows.map((r) => ({
      ...r,
      subjects: (subjStmt.all(r.email) as unknown as { subject: string }[]).map((s) => s.subject),
    }));
  }

  /** Move `new` rows into `ranking` and hand them back. A crash leaves them claimed;
   *  resetStaleClaims() releases them on the next boot. */
  claimMessagesForRanking(limit: number): MailMessageRow[] {
    const rows = this.db
      .prepare(
        `SELECT ${MESSAGE_COLS} FROM mail_messages
          WHERE state='new' ORDER BY sent_at DESC, id LIMIT ?`,
      )
      .all(limit) as unknown as MailMessageRow[];
    this.setMessageStates(rows.map((r) => r.id), 'ranking');
    return rows;
  }

  claimMessagesForTriage(limit: number, threshold: number): MailMessageRow[] {
    const rows = this.db
      .prepare(
        `SELECT ${MESSAGE_COLS} FROM mail_messages
          WHERE state='ranked' AND rank >= ?
          ORDER BY rank DESC, sent_at DESC LIMIT ?`,
      )
      .all(threshold, limit) as unknown as MailMessageRow[];
    this.setMessageStates(rows.map((r) => r.id), 'queued');
    return rows;
  }

  setMessageStates(ids: number[], state: MailMessageState): void {
    if (ids.length === 0) return;
    const ts = this.clock();
    const stmt = this.db.prepare('UPDATE mail_messages SET state=?, updated_at=? WHERE id=?');
    this.db.exec('BEGIN');
    try {
      for (const id of ids) stmt.run(state, ts, id);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  applyRank(input: {
    id: number;
    rank: number;
    reason: string;
    source: string;
    state: MailMessageState;
  }): void {
    this.db
      .prepare(
        `UPDATE mail_messages SET rank=?, rank_reason=?, rank_source=?, state=?, updated_at=? WHERE id=?`,
      )
      .run(input.rank, input.reason.slice(0, 200), input.source, input.state, this.clock(), input.id);
  }

  /** Rank every unranked message from a sender in one statement — the sender-verdict fast path. */
  applyRankBySender(input: {
    email: string;
    rank: number;
    reason: string;
    source: string;
    state: MailMessageState;
  }): number {
    const res = this.db
      .prepare(
        `UPDATE mail_messages SET rank=?, rank_reason=?, rank_source=?, state=?, updated_at=?
          WHERE sender_email=? AND state IN ('new','ranking')`,
      )
      .run(
        input.rank,
        input.reason.slice(0, 200),
        input.source,
        input.state,
        this.clock(),
        input.email,
      );
    return Number(res.changes);
  }

  /** Release a claim without recording a rank; 3 strikes and the row is parked. */
  releaseMessages(ids: number[], to: MailMessageState, failState: MailMessageState, maxAttempts = 3): void {
    if (ids.length === 0) return;
    const ts = this.clock();
    const stmt = this.db.prepare(
      `UPDATE mail_messages
          SET attempts=attempts+1,
              state=CASE WHEN attempts+1 >= ? THEN ? ELSE ? END,
              updated_at=?
        WHERE id=?`,
    );
    this.db.exec('BEGIN');
    try {
      for (const id of ids) stmt.run(maxAttempts, failState, to, ts, id);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  setMaterialized(id: number, mdPath: string, attDir: string | null): void {
    const ts = this.clock();
    this.db
      .prepare('UPDATE mail_messages SET md_path=?, att_dir=?, materialized_at=?, updated_at=? WHERE id=?')
      .run(mdPath, attDir, ts, ts, id);
  }

  /** Boot recovery: anything claimed by a process that died goes back in the pool. */
  resetStaleClaims(): { ranking: number; queued: number } {
    const ts = this.clock();
    const a = this.db
      .prepare(`UPDATE mail_messages SET state='new', updated_at=? WHERE state='ranking'`)
      .run(ts);
    const b = this.db
      .prepare(`UPDATE mail_messages SET state='ranked', updated_at=? WHERE state='queued'`)
      .run(ts);
    return { ranking: Number(a.changes), queued: Number(b.changes) };
  }

  // -- senders ---------------------------------------------------------------

  getSender(email: string): MailSenderRow | undefined {
    return this.db.prepare(`SELECT ${SENDER_COLS} FROM mail_senders WHERE email=?`).get(email) as
      | unknown as MailSenderRow | undefined;
  }

  getSenderById(id: number): MailSenderRow | undefined {
    return this.db.prepare(`SELECT ${SENDER_COLS} FROM mail_senders WHERE id=?`).get(id) as
      | unknown as MailSenderRow | undefined;
  }

  upsertSender(input: {
    email: string;
    displayName: string;
    verdict: SenderVerdict;
    why: string;
    source: 'model' | 'owner';
  }): void {
    const ts = this.clock();
    this.db
      .prepare(
        `INSERT INTO mail_senders(email,display_name,verdict,why,source,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?)
         ON CONFLICT(email) DO UPDATE SET
           verdict=excluded.verdict, why=excluded.why, source=excluded.source,
           display_name=excluded.display_name, active=1, updated_at=excluded.updated_at`,
      )
      .run(input.email, input.displayName, input.verdict, input.why.slice(0, 300), input.source, ts, ts);
  }

  setSenderVerdict(id: number, verdict: SenderVerdict): void {
    this.db
      .prepare(`UPDATE mail_senders SET verdict=?, source='owner', active=1, updated_at=? WHERE id=?`)
      .run(verdict, this.clock(), id);
  }

  deleteSender(id: number): void {
    this.db.prepare('DELETE FROM mail_senders WHERE id=?').run(id);
  }

  bumpSenderHits(email: string, n: number): void {
    this.db
      .prepare('UPDATE mail_senders SET hits=hits+?, updated_at=? WHERE email=?')
      .run(n, this.clock(), email);
  }

  listSenders(limit: number, offset: number): MailSenderRow[] {
    return this.db
      .prepare(`SELECT ${SENDER_COLS} FROM mail_senders ORDER BY hits DESC, id LIMIT ? OFFSET ?`)
      .all(limit, offset) as unknown as MailSenderRow[];
  }

  senderCounts(): { model: number; owner: number } {
    const r = this.db
      .prepare(
        `SELECT SUM(source='model') AS model, SUM(source='owner') AS owner FROM mail_senders WHERE active=1`,
      )
      .get() as unknown as { model: number | null; owner: number | null };
    return { model: r.model ?? 0, owner: r.owner ?? 0 };
  }

  // -- filed + links ---------------------------------------------------------

  recordFiled(input: Omit<MailFiledRow, 'id' | 'filedAt'> & { sha256: string | null }): void {
    this.db
      .prepare(
        `INSERT INTO mail_filed(message_id,kind,project,display_name,dest_path,sha256,reused,why,filed_at)
         VALUES(?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        input.messageId,
        input.kind,
        input.project,
        input.displayName,
        input.destPath,
        input.sha256,
        input.reused,
        input.why.slice(0, 300),
        this.clock(),
      );
  }

  listFiled(limit: number, offset: number): MailFiledRow[] {
    return this.db
      .prepare(
        `SELECT id, message_id AS messageId, kind, project, display_name AS displayName,
                dest_path AS destPath, reused, why, filed_at AS filedAt
           FROM mail_filed ORDER BY filed_at DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .all(limit, offset) as unknown as MailFiledRow[];
  }

  /** How many filings happened since an ISO timestamp — backs the per-fire budget. */
  filedSince(since: string): number {
    const r = this.db
      .prepare('SELECT COUNT(*) AS n FROM mail_filed WHERE filed_at >= ?')
      .get(since) as unknown as { n: number };
    return r.n;
  }

  recordLink(input: { messageId: number; url: string; title: string; project: string; why: string }): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO mail_links(message_id,url,title,project,why,recorded_at)
         VALUES(?,?,?,?,?,?)`,
      )
      .run(
        input.messageId,
        input.url,
        input.title.slice(0, 200),
        input.project,
        input.why.slice(0, 300),
        this.clock(),
      );
  }

  listLinks(limit: number, offset: number): MailLinkRow[] {
    return this.db
      .prepare(
        `SELECT id, message_id AS messageId, url, title, project, why, recorded_at AS recordedAt
           FROM mail_links ORDER BY recorded_at DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .all(limit, offset) as unknown as MailLinkRow[];
  }
}
