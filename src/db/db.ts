import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { DB_PATH } from '../core/config.js';
import { logger } from '../core/logger.js';

let db: Database.Database;

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      channel    TEXT PRIMARY KEY,
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

export function getSession(channelKey: string): string | null {
  const row = getDb()
    .prepare('SELECT session_id FROM sessions WHERE channel = ?')
    .get(channelKey) as { session_id: string } | undefined;
  return row?.session_id ?? null;
}

export function setSession(channelKey: string, sessionId: string): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO sessions (channel, session_id, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(channel) DO UPDATE SET
         session_id = excluded.session_id,
         updated_at = excluded.updated_at`,
    )
    .run(channelKey, sessionId, now);
}

export function clearSession(channelKey: string): void {
  getDb().prepare('DELETE FROM sessions WHERE channel = ?').run(channelKey);
}
