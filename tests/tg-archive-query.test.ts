import './env.js';

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { formatHitLines, TelegramArchiveQuery } from '../src/connectors/telegram/archiveQuery.js';
import { TelegramArchiveStore } from '../src/connectors/telegram/archiveStore.js';
import type { TelegramMessage } from '../src/connectors/telegram/types.js';
import { migrateDb } from '../src/db.js';

const msg = (over: Partial<TelegramMessage> & Pick<TelegramMessage, 'messageId' | 'text'>): TelegramMessage => ({
  peerKey: 'dm:1',
  senderKey: 'user:1',
  senderName: 'Alice',
  sentAt: '2026-01-01T00:00:00.000Z',
  entitiesJson: '[]',
  reactionsJson: '[]',
  media: [],
  links: [],
  ...over,
});

const seeded = () => {
  const db = new DatabaseSync(':memory:');
  migrateDb(db);
  const store = new TelegramArchiveStore(db);
  store.upsertDialog({
    peerKey: 'supergroup:99',
    kind: 'supergroup',
    title: 'Morian',
    username: 'morianchat',
    selected: true,
  });
  store.upsertDialog({ peerKey: 'dm:1', kind: 'dm', title: 'Alice', selected: true });
  store.upsertDialog({ peerKey: 'dm:2', kind: 'dm', title: 'Bob', selected: false });
  store.applyMessages(
    [
      msg({ peerKey: 'supergroup:99', messageId: 10, text: 'ship the duck chassis next week' }),
      msg({ peerKey: 'supergroup:99', messageId: 11, text: 'neighbor before' }),
      msg({ peerKey: 'supergroup:99', messageId: 12, text: 'neighbor after' }),
      msg({ peerKey: 'dm:1', messageId: 7, text: 'secret duck note' }),
      msg({ peerKey: 'dm:2', messageId: 1, text: 'unselected duck should not hit' }),
    ],
    'backfill',
  );
  store.markDeleted('dm:1', [7], '2026-01-02T00:00:00.000Z');
  return new TelegramArchiveQuery(store);
};

test('search finds selected chats, excludes deleted by default, builds deep links', () => {
  const q = seeded();
  const hits = q.search({ query: 'duck' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].peerKey, 'supergroup:99');
  assert.equal(hits[0].messageId, 10);
  assert.equal(hits[0].chatTitle, 'Morian');
  assert.equal(hits[0].deepLink, 'https://t.me/morianchat/10');
  assert.equal(hits[0].deleted, false);
});

test('search includeDeleted returns tombstoned rows', () => {
  const q = seeded();
  const hits = q.search({ query: 'duck', includeDeleted: true });
  assert.equal(hits.some((h) => h.peerKey === 'dm:1' && h.deleted), true);
});

test('search clamps limit and rejects empty query', () => {
  const q = seeded();
  assert.throws(() => q.search({ query: '   ' }), /empty/i);
  const hits = q.search({ query: 'duck chassis', limit: 100 });
  assert.ok(hits.length <= 25);
});

test('search escapes FTS operators in user input', () => {
  const q = seeded();
  assert.doesNotThrow(() => q.search({ query: 'duck AND OR * "weird' }));
});

test('window loads neighbors chronologically and supports supergroup deep link without username', () => {
  const db = new DatabaseSync(':memory:');
  migrateDb(db);
  const store = new TelegramArchiveStore(db);
  store.upsertDialog({ peerKey: 'supergroup:5', kind: 'supergroup', title: 'Private', selected: true });
  for (const id of [8, 9, 10, 11, 12]) {
    store.applyMessages(
      [msg({ peerKey: 'supergroup:5', messageId: id, text: `m${id}` })],
      'backfill',
    );
  }
  const q = new TelegramArchiveQuery(store);
  const win = q.window({ peerKey: 'supergroup:5', messageId: 10, before: 1, after: 1 });
  assert.equal(win.anchor.messageId, 10);
  assert.deepEqual(
    win.messages.map((m) => m.messageId),
    [9, 10, 11],
  );
  assert.equal(win.messages[1].deepLink, 'https://t.me/c/5/10');
});

test('window not-found for missing message', () => {
  const q = seeded();
  assert.throws(() => q.window({ peerKey: 'supergroup:99', messageId: 999 }), /not found/i);
});

test('formatters label archived third-party text for tools', () => {
  const q = seeded();
  const hits = q.search({ query: 'chassis' });
  const body = formatHitLines(hits);
  assert.match(body, /t\.me/);
  assert.match(body, /Morian/);
});
