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
  `
  CREATE TABLE tg_chats (
    peer_key TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('dm','group','supergroup')),
    title TEXT NOT NULL,
    username TEXT,
    access_hash TEXT,
    selected INTEGER NOT NULL DEFAULT 0,
    last_live_at TEXT,
    last_reconciled_at TEXT,
    health_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE tg_participants (
    peer_key TEXT NOT NULL REFERENCES tg_chats(peer_key) ON DELETE CASCADE,
    participant_key TEXT NOT NULL,
    display_name TEXT,
    username TEXT,
    observed_at TEXT NOT NULL,
    PRIMARY KEY(peer_key, participant_key)
  );
  CREATE TABLE tg_messages (
    peer_key TEXT NOT NULL REFERENCES tg_chats(peer_key) ON DELETE CASCADE,
    message_id INTEGER NOT NULL,
    sender_key TEXT,
    sender_name TEXT,
    sent_at TEXT NOT NULL,
    edited_at TEXT,
    deleted_at TEXT,
    reply_to_message_id INTEGER,
    grouped_id TEXT,
    text TEXT NOT NULL DEFAULT '',
    entities_json TEXT NOT NULL DEFAULT '[]',
    reactions_json TEXT NOT NULL DEFAULT '[]',
    content_hash TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    triage_pending INTEGER NOT NULL DEFAULT 0,
    triaged_at TEXT,
    PRIMARY KEY(peer_key, message_id)
  );
  CREATE INDEX idx_tg_messages_sender ON tg_messages(peer_key, sender_key, sent_at);
  CREATE INDEX idx_tg_messages_untriaged
    ON tg_messages(peer_key, triage_pending, triaged_at, message_id);
  CREATE TABLE tg_message_versions (
    peer_key TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    version_hash TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    edited_at TEXT,
    text TEXT NOT NULL,
    entities_json TEXT NOT NULL,
    reactions_json TEXT NOT NULL,
    poll_json TEXT,
    PRIMARY KEY(peer_key, message_id, version_hash),
    FOREIGN KEY(peer_key, message_id) REFERENCES tg_messages(peer_key, message_id) ON DELETE CASCADE
  );
  CREATE TABLE tg_media (
    media_key TEXT PRIMARY KEY,
    peer_key TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    filename TEXT,
    mime_type TEXT,
    expected_size INTEGER,
    descriptor_json TEXT NOT NULL,
    blob_hash TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    bytes INTEGER,
    error TEXT,
    retry_at TEXT,
    FOREIGN KEY(peer_key, message_id) REFERENCES tg_messages(peer_key, message_id) ON DELETE CASCADE
  );
  CREATE INDEX idx_tg_media_status ON tg_media(status, retry_at);
  CREATE TABLE tg_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    peer_key TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    original_url TEXT NOT NULL,
    normalized_url TEXT NOT NULL,
    preview_json TEXT,
    final_url TEXT,
    response_json TEXT,
    snapshot_hash TEXT,
    extracted_text TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT,
    fetched_at TEXT,
    UNIQUE(peer_key, message_id, original_url),
    FOREIGN KEY(peer_key, message_id) REFERENCES tg_messages(peer_key, message_id) ON DELETE CASCADE
  );
  CREATE INDEX idx_tg_links_status ON tg_links(status);
  CREATE TABLE tg_import_jobs (
    peer_key TEXT PRIMARY KEY REFERENCES tg_chats(peer_key) ON DELETE CASCADE,
    state TEXT NOT NULL,
    total_messages INTEGER,
    imported_messages INTEGER NOT NULL DEFAULT 0,
    oldest_message_id INTEGER,
    discovered_media_bytes INTEGER NOT NULL DEFAULT 0,
    downloaded_media_bytes INTEGER NOT NULL DEFAULT 0,
    failed_media INTEGER NOT NULL DEFAULT 0,
    failed_links INTEGER NOT NULL DEFAULT 0,
    next_retry_at TEXT,
    last_error TEXT,
    started_at TEXT,
    completed_at TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE tg_work_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    peer_key TEXT NOT NULL REFERENCES tg_chats(peer_key) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('media','link','targeted_fetch')),
    item_key TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    next_retry_at TEXT,
    last_error TEXT,
    UNIQUE(kind, item_key)
  );
  CREATE INDEX idx_tg_work_claim ON tg_work_items(state, next_retry_at, id);
  CREATE TABLE tg_update_state (
    state_key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    verified_at TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE VIRTUAL TABLE tg_message_fts USING fts5(
    peer_key UNINDEXED,
    message_id UNINDEXED,
    text,
    link_text,
    tokenize='unicode61'
  );
  `,
  `
  CREATE TABLE tg_project_proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    peer_key TEXT NOT NULL REFERENCES tg_chats(peer_key) ON DELETE CASCADE,
    wiki_project TEXT NOT NULL,
    evidence TEXT NOT NULL,
    score REAL NOT NULL,
    fingerprint TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','approved','rejected')),
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    UNIQUE(peer_key, fingerprint)
  );
  CREATE INDEX idx_tg_project_proposals_pending
    ON tg_project_proposals(state, peer_key);
  CREATE TABLE tg_project_mappings (
    peer_key TEXT PRIMARY KEY REFERENCES tg_chats(peer_key) ON DELETE CASCADE,
    wiki_project TEXT NOT NULL,
    brief_path TEXT NOT NULL,
    approved_at TEXT NOT NULL,
    proposal_id INTEGER REFERENCES tg_project_proposals(id)
  );
  CREATE INDEX idx_tg_project_mappings_project ON tg_project_mappings(wiki_project);
  `,
  `
  ALTER TABLE tg_project_proposals ADD COLUMN notified_at TEXT;
  CREATE INDEX idx_tg_project_proposals_unnotified
    ON tg_project_proposals(state, notified_at)
    WHERE state='pending' AND notified_at IS NULL;
  `,
  `
  CREATE TABLE raw_shelf (
    project TEXT NOT NULL,
    sha256 TEXT NOT NULL CHECK(length(sha256)=64),
    rel_path TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (project, sha256)
  );
  CREATE INDEX idx_raw_shelf_project ON raw_shelf(project);
  `,
];

export let db: DatabaseSync;

export function migrateDb(target: DatabaseSync): void {
  target.exec('PRAGMA foreign_keys=ON');
  const { user_version: version } = target.prepare('PRAGMA user_version').get() as {
    user_version: number;
  };
  for (let v = version; v < MIGRATIONS.length; v++) {
    target.exec('BEGIN');
    try {
      target.exec(MIGRATIONS[v]);
      target.exec(`PRAGMA user_version=${v + 1}`);
      target.exec('COMMIT');
    } catch (error) {
      target.exec('ROLLBACK');
      throw error;
    }
  }
}

export function openDb(): DatabaseSync {
  mkdirSync(path.dirname(cfg.dbPath), { recursive: true });
  db = new DatabaseSync(cfg.dbPath);
  db.exec('PRAGMA journal_mode=WAL');
  migrateDb(db);
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
