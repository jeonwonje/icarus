import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { DB_PATH } from './config.js';
import { logger } from './logger.js';

export interface StoredMessage {
  id: number;
  telegramMsgId: string;
  chatJid: string;
  threadId: number | null;
  senderId: string;
  senderName: string | null;
  content: string;
  timestamp: string;
  isBot: boolean;
}

export interface NewMessage {
  telegramMsgId: string;
  chatJid: string;
  threadId: number | null;
  senderId: string;
  senderName: string | null;
  content: string;
  timestamp: string;
  isBot?: boolean;
}

let db: Database.Database;

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_msg_id TEXT NOT NULL,
      chat_jid        TEXT NOT NULL,
      thread_id       INTEGER,
      sender_id       TEXT NOT NULL,
      sender_name     TEXT,
      content         TEXT NOT NULL,
      timestamp       TEXT NOT NULL,
      is_bot          INTEGER DEFAULT 0,
      UNIQUE (telegram_msg_id, chat_jid)
    );
    CREATE INDEX IF NOT EXISTS idx_messages_chat_ts
      ON messages(chat_jid, timestamp);

    CREATE TABLE IF NOT EXISTS sessions (
      thread_jid TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

/**
 * Open (or create) the SQLite database. Pass a custom path for tests —
 * use `:memory:` to avoid touching the filesystem.
 */
export function openDb(dbPath: string = DB_PATH): Database.Database {
  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
  const database = new Database(dbPath);
  database.pragma('journal_mode = WAL');
  createSchema(database);
  db = database;
  logger.debug({ dbPath }, 'db opened');
  return database;
}

export function getDb(): Database.Database {
  if (!db) throw new Error('db not initialized — call openDb() first');
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = undefined as unknown as Database.Database;
  }
}

// --- messages -----------------------------------------------------------

export function insertMessage(m: NewMessage): number {
  const row = getDb()
    .prepare(
      `INSERT OR IGNORE INTO messages
       (telegram_msg_id, chat_jid, thread_id, sender_id, sender_name, content, timestamp, is_bot)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      m.telegramMsgId,
      m.chatJid,
      m.threadId,
      m.senderId,
      m.senderName,
      m.content,
      m.timestamp,
      m.isBot ? 1 : 0,
    );
  return Number(row.lastInsertRowid);
}

// --- sessions -----------------------------------------------------------
//
// One claude session per Telegram thread. Keyed by the thread JID
// (`tg:<chat_id>:<thread_id>`) so chat moves don't collide.

export function getSession(threadJid: string): string | null {
  const row = getDb()
    .prepare('SELECT session_id FROM sessions WHERE thread_jid = ?')
    .get(threadJid) as { session_id: string } | undefined;
  return row?.session_id ?? null;
}

export function setSession(threadJid: string, sessionId: string): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO sessions (thread_jid, session_id, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(thread_jid) DO UPDATE SET
         session_id = excluded.session_id,
         updated_at = excluded.updated_at`,
    )
    .run(threadJid, sessionId, now);
}

export function clearSession(threadJid: string): void {
  getDb().prepare('DELETE FROM sessions WHERE thread_jid = ?').run(threadJid);
}
