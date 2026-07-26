import './env.js';

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrateDb } from '../src/db.js';

test('telegram migration creates archive tables and FTS5 index', () => {
  const db = new DatabaseSync(':memory:');
  migrateDb(db);
  const names = (
    db.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name`).all() as {
      name: string;
    }[]
  ).map((r) => r.name);
  for (const expected of [
    'raw_shelf',
    'tg_chats',
    'tg_import_jobs',
    'tg_links',
    'tg_media',
    'tg_message_fts',
    'tg_message_versions',
    'tg_messages',
    'tg_participants',
    'tg_project_mappings',
    'tg_project_proposals',
    'tg_update_state',
    'tg_work_items',
  ]) {
    assert.ok(names.includes(expected), `missing ${expected}`);
  }
  assert.equal(
    (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    6,
  );
});

test('telegram message identity is unique per chat', () => {
  const db = new DatabaseSync(':memory:');
  migrateDb(db);
  db.prepare(`INSERT INTO tg_chats(peer_key,kind,title,selected,created_at,updated_at)
              VALUES('dm:1','dm','Alice',1,'x','x')`).run();
  const insert = db.prepare(`INSERT INTO tg_messages
    (peer_key,message_id,sent_at,text,content_hash,observed_at)
    VALUES('dm:1',7,'x','hello','h','x')`);
  insert.run();
  assert.throws(() => insert.run(), /UNIQUE/);
});
