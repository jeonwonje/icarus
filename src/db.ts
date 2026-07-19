import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { cfg } from './config.js';

// Versioned migrations: index+1 = PRAGMA user_version after applying.
const MIGRATIONS: string[] = [
  `
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE sessions (
    jid TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    jid TEXT NOT NULL,
    kind TEXT NOT NULL,             -- chat | job:<name> | eval
    started_at TEXT NOT NULL,
    ended_at TEXT,
    status TEXT NOT NULL,           -- running | ok | error | aborted
    session_id TEXT,
    prompt_preview TEXT,
    result_preview TEXT,
    error TEXT,
    duration_ms INTEGER
  );
  CREATE INDEX idx_turns_jid ON turns(jid, id);
  CREATE TABLE schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    cron TEXT NOT NULL,
    tz TEXT,
    prompt TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    catch_up INTEGER NOT NULL DEFAULT 0,
    system INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_fired_at TEXT,
    last_status TEXT,
    last_result_preview TEXT
  );
  CREATE TABLE feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    kind TEXT NOT NULL,             -- positive | negative | correction | preference
    summary TEXT NOT NULL,
    quote TEXT,
    jid TEXT,
    session_id TEXT,
    status TEXT NOT NULL DEFAULT 'new',  -- new | mined | addressed
    proposal_id INTEGER
  );
  CREATE TABLE proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    target TEXT NOT NULL,           -- persona | lessons
    evidence TEXT NOT NULL,
    cause TEXT NOT NULL,
    diff TEXT NOT NULL,
    new_content TEXT NOT NULL,
    predicted_impact TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected | reverted
    commit_sha TEXT,
    eval_summary TEXT
  );
  CREATE TABLE eval_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    case_id TEXT NOT NULL,
    persona_ref TEXT NOT NULL,      -- 'current' | 'proposal:<id>'
    verdict TEXT NOT NULL,          -- PASS | FAIL | ERROR
    judge_reason TEXT
  );
  CREATE TABLE connector_state (
    name TEXT PRIMARY KEY,
    watermark TEXT,
    updated_at TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE connector_items (
    source TEXT NOT NULL,
    item_id TEXT NOT NULL,
    processed_at TEXT NOT NULL,
    PRIMARY KEY (source, item_id)
  );
  `,
];

export let db: DatabaseSync;

export function openDb(): DatabaseSync {
  mkdirSync(path.dirname(cfg.dbPath), { recursive: true });
  db = new DatabaseSync(cfg.dbPath);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA foreign_keys=ON');
  const { user_version: version } = db
    .prepare('PRAGMA user_version')
    .get() as { user_version: number };
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version=${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return db;
}

export const now = () => new Date().toISOString();

export function getSetting(key: string): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
  ).run(key, value);
}
