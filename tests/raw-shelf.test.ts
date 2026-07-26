import './env.js';

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrateDb } from '../src/db.js';
import { RawShelfStore } from '../src/rawShelfStore.js';

test('raw_shelf store upserts and gets by project+sha', () => {
  const db = new DatabaseSync(':memory:');
  migrateDb(db);
  const store = new RawShelfStore(db);
  assert.equal(store.get('morianlabs', 'a'.repeat(64)), undefined);
  store.upsert({
    project: 'morianlabs',
    sha256: 'a'.repeat(64),
    relPath: '2026-07-26_quote.pdf',
    bytes: 12,
    createdAt: '2026-07-26T00:00:00.000Z',
  });
  const row = store.get('morianlabs', 'a'.repeat(64));
  assert.equal(row?.relPath, '2026-07-26_quote.pdf');
  assert.equal(row?.bytes, 12);
});
