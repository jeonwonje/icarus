import './env.js';

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrateDb } from '../src/db.js';
import { fileToRaw, sanitizeDisplayName } from '../src/rawShelf.js';
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

test('fileToRaw shelves, dedups by hash, and disambiguates names', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'raw-shelf-'));
  const desktop = path.join(root, 'Desktop');
  const project = path.join(desktop, '1_Projects', 'morianlabs');
  mkdirSync(project, { recursive: true });
  const src = path.join(root, 'inbox-quote.pdf');
  writeFileSync(src, 'vendor quote v1');

  const db = new DatabaseSync(':memory:');
  migrateDb(db);
  const store = new RawShelfStore(db);
  const now = new Date('2026-07-26T12:00:00.000Z');

  const first = await fileToRaw({
    project: 'morianlabs',
    sourcePath: src,
    displayName: 'quote.pdf',
    store,
    now,
    desktopDir: desktop,
    tz: 'UTC',
  });
  assert.equal(path.basename(first.path), '2026-07-26_quote.pdf');
  assert.equal(first.reused, false);
  assert.equal(readFileSync(first.path, 'utf8'), 'vendor quote v1');

  const second = await fileToRaw({
    project: 'morianlabs',
    sourcePath: src,
    displayName: 'quote.pdf',
    store,
    now,
    desktopDir: desktop,
    tz: 'UTC',
  });
  assert.equal(second.reused, true);
  assert.equal(second.path, first.path);
  assert.equal(readdirSync(path.join(project, 'raw')).length, 1);

  const other = path.join(root, 'other.pdf');
  writeFileSync(other, 'different bytes');
  const third = await fileToRaw({
    project: 'morianlabs',
    sourcePath: other,
    displayName: 'quote.pdf',
    store,
    now,
    desktopDir: desktop,
    tz: 'UTC',
  });
  assert.equal(third.reused, false);
  assert.equal(path.basename(third.path), '2026-07-26_quote-2.pdf');
  assert.ok(existsSync(third.path));
});

test('fileToRaw refuses missing project or source', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'raw-shelf-miss-'));
  const desktop = path.join(root, 'Desktop');
  mkdirSync(path.join(desktop, '1_Projects'), { recursive: true });
  const db = new DatabaseSync(':memory:');
  migrateDb(db);
  const store = new RawShelfStore(db);
  await assert.rejects(
    () =>
      fileToRaw({
        project: 'missing',
        sourcePath: path.join(root, 'nope.pdf'),
        displayName: 'nope.pdf',
        store,
        desktopDir: desktop,
      }),
    /missing/,
  );
});

test('sanitizeDisplayName strips path and unsafe chars', () => {
  assert.equal(sanitizeDisplayName('C:\\tmp\\a:b?.pdf'), 'a_b_.pdf');
});
