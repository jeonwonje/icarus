import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { DB_PATH } from './config.js';
import { logger } from './logger.js';

const SESSION_KEY = 'life';

export interface NewMessage {
  telegramMsgId: string;
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
      telegram_msg_id TEXT NOT NULL UNIQUE,
      sender_id       TEXT NOT NULL,
      sender_name     TEXT,
      content         TEXT NOT NULL,
      timestamp       TEXT NOT NULL,
      is_bot          INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS sessions (
      key        TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

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

export function insertMessage(m: NewMessage): number {
  const row = getDb()
    .prepare(
      `INSERT OR IGNORE INTO messages
       (telegram_msg_id, sender_id, sender_name, content, timestamp, is_bot)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      m.telegramMsgId,
      m.senderId,
      m.senderName,
      m.content,
      m.timestamp,
      m.isBot ? 1 : 0,
    );
  return Number(row.lastInsertRowid);
}

export function getSession(): string | null {
  const row = getDb()
    .prepare('SELECT session_id FROM sessions WHERE key = ?')
    .get(SESSION_KEY) as { session_id: string } | undefined;
  return row?.session_id ?? null;
}

export function setSession(sessionId: string): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO sessions (key, session_id, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         session_id = excluded.session_id,
         updated_at = excluded.updated_at`,
    )
    .run(SESSION_KEY, sessionId, now);
}

export function clearSession(): void {
  getDb().prepare('DELETE FROM sessions WHERE key = ?').run(SESSION_KEY);
}
