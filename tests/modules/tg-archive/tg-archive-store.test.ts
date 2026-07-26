import '../../env.js';

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { TelegramArchiveStore } from '../../../src/modules/tg-archive/archiveStore.js';
import type { TelegramMessage } from '../../../src/modules/tg-archive/types.js';
import { migrateDb } from '../../../src/db.js';

const makeMessage = (text: string, editedAt?: string): TelegramMessage => ({
  peerKey: 'dm:1',
  messageId: 7,
  senderKey: 'user:1',
  senderName: 'Alice',
  sentAt: '2026-01-01T00:00:00.000Z',
  editedAt,
  text,
  entitiesJson: '[]',
  reactionsJson: '[]',
  media: [],
  links: [],
});

const freshStore = () => {
  const db = new DatabaseSync(':memory:');
  migrateDb(db);
  return { db, store: new TelegramArchiveStore(db) };
};

test('message replay is idempotent and edits preserve versions and FTS current text', () => {
  const db = new DatabaseSync(':memory:');
  migrateDb(db);
  const store = new TelegramArchiveStore(db);
  store.upsertDialog({ peerKey: 'dm:1', kind: 'dm', title: 'Alice', selected: true });
  store.applyMessages([makeMessage('first')], 'live');
  store.applyMessages([makeMessage('first')], 'backfill');
  store.applyMessages([makeMessage('second', '2026-01-01T00:01:00.000Z')], 'live');
  assert.equal(
    (db.prepare('SELECT COUNT(1) AS n FROM tg_messages').get() as { n: number }).n,
    1,
  );
  assert.equal(
    (db.prepare('SELECT COUNT(1) AS n FROM tg_message_versions').get() as { n: number }).n,
    2,
  );
  const hits = db.prepare(`SELECT text FROM tg_message_fts WHERE tg_message_fts MATCH 'second'`).all();
  assert.equal(hits.length, 1);
  assert.equal(
    (db.prepare(`SELECT COUNT(1) AS n FROM tg_message_fts WHERE tg_message_fts MATCH 'first'`)
      .get() as { n: number }).n,
    0,
  );
});

test('deletion retains content and marks the observation time', () => {
  const db = new DatabaseSync(':memory:');
  migrateDb(db);
  const store = new TelegramArchiveStore(db);
  store.upsertDialog({ peerKey: 'dm:1', kind: 'dm', title: 'Alice', selected: true });
  store.applyMessages([makeMessage('retain me')], 'live');
  store.markDeleted(undefined, [7], '2026-01-02T00:00:00.000Z');
  const row = db.prepare(`SELECT text,deleted_at FROM tg_messages WHERE message_id=7`).get();
  // node:sqlite rows have a null prototype; spread into a plain object before deepEqual.
  assert.deepEqual(
    { ...row },
    {
      text: 'retain me',
      deleted_at: '2026-01-02T00:00:00.000Z',
    },
  );
});

test('applyMessages never sets triage_pending; markTriageEligible does', () => {
  const { db, store } = freshStore();
  store.upsertDialog({ peerKey: 'dm:1', kind: 'dm', title: 'Alice', selected: true });
  store.applyMessages([{ ...makeMessage('backfilled'), messageId: 1 }], 'backfill');
  store.applyMessages([{ ...makeMessage('lively'), messageId: 2 }], 'live');
  const before = (
    db.prepare('SELECT message_id,triage_pending FROM tg_messages ORDER BY message_id').all() as {
      message_id: number;
      triage_pending: number;
    }[]
  ).map((r) => ({ ...r }));
  assert.deepEqual(before, [
    { message_id: 1, triage_pending: 0 },
    { message_id: 2, triage_pending: 0 },
  ]);
  assert.equal(store.markTriageEligible('dm:1', 2), true);
  assert.equal(
    (db.prepare('SELECT triage_pending FROM tg_messages WHERE message_id=2').get() as {
      triage_pending: number;
    }).triage_pending,
    1,
  );
});

test('recordHistoryPage applies messages and import progress in one transaction', () => {
  const { db, store } = freshStore();
  store.upsertDialog({ peerKey: 'dm:1', kind: 'dm', title: 'Alice', selected: true });
  store.createImport('dm:1', 10);
  store.recordHistoryPage(
    'dm:1',
    [
      { ...makeMessage('older'), messageId: 5 },
      { ...makeMessage('oldest'), messageId: 4 },
    ],
    4,
  );
  assert.equal(
    (db.prepare('SELECT COUNT(1) AS n FROM tg_messages').get() as { n: number }).n,
    2,
  );
  const job = store.getImport('dm:1');
  assert.equal(job?.importedMessages, 2);
  assert.equal(job?.oldestMessageId, 4);
  // messages recorded via recordHistoryPage are backfill, never triage-pending
  const pending = db
    .prepare('SELECT COUNT(1) AS n FROM tg_messages WHERE triage_pending=1')
    .get() as { n: number };
  assert.equal(pending.n, 0);
});

test('import lifecycle: create, claim, transition, and sweep completion', () => {
  const { store } = freshStore();
  store.upsertDialog({ peerKey: 'dm:1', kind: 'dm', title: 'Alice', selected: true });
  store.createImport('dm:1', 2);
  assert.equal(store.getImport('dm:1')?.state, 'acquiring');
  assert.equal(store.claimImport('2026-01-01T00:00:00.000Z')?.peerKey, 'dm:1');
  store.recordHistoryPage('dm:1', [makeMessage('a'), { ...makeMessage('b'), messageId: 8 }], null);
  store.completeReadyImports('2026-01-01T00:00:00.000Z');
  assert.equal(store.getImport('dm:1')?.state, 'complete');
  store.setImportState('dm:1', 'error', 'boom');
  assert.equal(store.getImport('dm:1')?.lastError, 'boom');
});

test('work items dedupe across replay and support claim/complete/fail', () => {
  const { db, store } = freshStore();
  store.upsertDialog({ peerKey: 'dm:1', kind: 'dm', title: 'Alice', selected: true });
  const withMedia: TelegramMessage = {
    ...makeMessage('has media'),
    media: [{ mediaKey: 'm1', kind: 'photo', descriptorJson: '{}' }],
  };
  store.applyMessages([withMedia], 'live');
  store.applyMessages([withMedia], 'backfill');
  assert.equal(
    (db.prepare(`SELECT COUNT(1) AS n FROM tg_work_items WHERE item_key='m1'`).get() as { n: number }).n,
    1,
  );
  const item = store.claimWorkItem('2026-01-01T00:00:00.000Z');
  assert.equal(item?.itemKey, 'm1');
  assert.equal(item?.state, 'in_progress');
  store.failWorkItem(item!.id, 'network error', '2026-01-01T01:00:00.000Z');
  const retried = db.prepare('SELECT state,attempts,next_retry_at FROM tg_work_items WHERE id=?').get(item!.id);
  assert.deepEqual(
    { ...retried },
    { state: 'pending', attempts: 1, next_retry_at: '2026-01-01T01:00:00.000Z' },
  );
  store.completeWorkItem(item!.id);
  assert.equal(
    (db.prepare('SELECT state FROM tg_work_items WHERE id=?').get(item!.id) as { state: string }).state,
    'done',
  );
});

test('replaceReactions and replacePoll preserve version history without touching text', () => {
  const { db, store } = freshStore();
  store.upsertDialog({ peerKey: 'dm:1', kind: 'dm', title: 'Alice', selected: true });
  store.applyMessages([makeMessage('hello')], 'live');
  store.replaceReactions('dm:1', 7, '[{"emoji":"👍","count":1}]', '2026-01-01T00:05:00.000Z');
  store.replacePoll(
    'dm:1',
    7,
    { pollId: 'p1', question: 'Q?', closed: false, options: [{ optionKey: 'a', text: 'A', chosen: false }] },
    '2026-01-01T00:06:00.000Z',
  );
  const message = db.prepare('SELECT text,reactions_json FROM tg_messages WHERE message_id=7').get() as {
    text: string;
    reactions_json: string;
  };
  assert.equal(message.text, 'hello');
  assert.equal(message.reactions_json, '[{"emoji":"👍","count":1}]');
  const versionCount = db
    .prepare('SELECT COUNT(1) AS n FROM tg_message_versions WHERE message_id=7')
    .get() as { n: number };
  assert.equal(versionCount.n, 3);
});

test('stale backfill does not overwrite a newer live edit', () => {
  const { db, store } = freshStore();
  store.upsertDialog({ peerKey: 'dm:1', kind: 'dm', title: 'Alice', selected: true });
  store.createImport('dm:1', 1);
  store.applyMessages([makeMessage('original')], 'live');
  store.applyMessages([makeMessage('edited', '2026-01-01T00:02:00.000Z')], 'live');
  // History page fetched before the edit (or simply older) commits after the live edit.
  store.recordHistoryPage('dm:1', [makeMessage('original')], null);
  assert.equal(store.getMessage('dm:1', 7)?.text, 'edited');
  assert.equal(
    (db.prepare(`SELECT text,edited_at FROM tg_messages WHERE message_id=7`).get() as {
      text: string;
      edited_at: string;
    }).edited_at,
    '2026-01-01T00:02:00.000Z',
  );
  const versionTexts = (
    db
      .prepare(`SELECT text FROM tg_message_versions WHERE message_id=7 ORDER BY observed_at, rowid`)
      .all() as { text: string }[]
  ).map((row) => row.text);
  assert.deepEqual(versionTexts, ['original', 'edited']);
  assert.equal(
    (db.prepare(`SELECT text FROM tg_message_fts WHERE tg_message_fts MATCH 'edited'`).all() as unknown[])
      .length,
    1,
  );
  assert.equal(
    (db.prepare(`SELECT COUNT(1) AS n FROM tg_message_fts WHERE tg_message_fts MATCH 'original'`)
      .get() as { n: number }).n,
    0,
  );
});

test('triage window loads context, and marking through clears the pending flag', () => {
  const { store } = freshStore();
  store.upsertDialog({ peerKey: 'dm:1', kind: 'dm', title: 'Alice', selected: true });
  store.applyMessages(
    [1, 2, 3].map((id) => ({ ...makeMessage(`m${id}`), messageId: id })),
    'live',
  );
  for (const id of [1, 2, 3]) assert.equal(store.markTriageEligible('dm:1', id), true);
  assert.deepEqual(store.getUntriagedRange('dm:1'), { fromId: 1, throughId: 3 });
  const window = store.loadTriageWindow('dm:1', 3, 2);
  assert.deepEqual(window.map((r) => r.messageId), [2, 3]);
  store.markTriagedThrough('dm:1', 3, '2026-01-01T00:10:00.000Z');
  assert.equal(store.getUntriagedRange('dm:1'), undefined);
  // Already-triaged rows must not be re-opened for a duplicate owner DM.
  assert.equal(store.markTriageEligible('dm:1', 2), false);
  assert.equal(store.getUntriagedRange('dm:1'), undefined);
});

test('markTriageEligible is a no-op when already pending or already triaged', () => {
  const { store } = freshStore();
  store.upsertDialog({ peerKey: 'dm:1', kind: 'dm', title: 'Alice', selected: true });
  store.applyMessages([{ ...makeMessage('live'), messageId: 2 }], 'live');
  assert.equal(store.markTriageEligible('dm:1', 2), true);
  assert.equal(store.markTriageEligible('dm:1', 2), false);
  store.markTriagedThrough('dm:1', 2, '2026-01-01T00:10:00.000Z');
  assert.equal(store.markTriageEligible('dm:1', 2), false);
  assert.equal(store.getUntriagedRange('dm:1'), undefined);
});

test('triage failure alerting fires once after threshold consecutive failures', () => {
  const { store } = freshStore();
  store.upsertDialog({ peerKey: 'dm:1', kind: 'dm', title: 'Alice', selected: true });
  for (let i = 0; i < 2; i++) {
    store.recordTriageResult('dm:1', 3, { status: 'error', finalText: '', error: 'boom' });
    assert.equal(store.shouldAlertTriageFailure('dm:1', 3), false);
  }
  store.recordTriageResult('dm:1', 3, { status: 'error', finalText: '', error: 'boom' });
  assert.equal(store.shouldAlertTriageFailure('dm:1', 3), true);
  assert.equal(store.shouldAlertTriageFailure('dm:1', 3), false);
  store.recordTriageResult('dm:1', 3, { status: 'ok', finalText: 'done' });
  assert.equal(store.shouldAlertTriageFailure('dm:1', 3), false);
});

test('triage failure alert does not re-fire for further failures in the same streak', () => {
  const { store } = freshStore();
  store.upsertDialog({ peerKey: 'dm:1', kind: 'dm', title: 'Alice', selected: true });
  for (let i = 0; i < 3; i++) {
    store.recordTriageResult('dm:1', 3, { status: 'error', finalText: '', error: 'boom' });
  }
  assert.equal(store.shouldAlertTriageFailure('dm:1', 3), true);
  // Recording a 4th and 5th consecutive failure in the same streak must not reset
  // `alerted`, so shouldAlertTriageFailure stays false for the rest of the streak.
  store.recordTriageResult('dm:1', 3, { status: 'error', finalText: '', error: 'boom' });
  assert.equal(store.shouldAlertTriageFailure('dm:1', 3), false);
  store.recordTriageResult('dm:1', 3, { status: 'error', finalText: '', error: 'boom' });
  assert.equal(store.shouldAlertTriageFailure('dm:1', 3), false);
});

test('chat selection, generic update state, and health reflect archive state', () => {
  const { store } = freshStore();
  store.upsertDialog({ peerKey: 'dm:1', kind: 'dm', title: 'Alice', selected: false });
  store.selectChat('dm:1', true);
  assert.equal(store.getChat('dm:1')?.selected, true);
  assert.deepEqual(store.listSelectedChats().map((c) => c.peerKey), ['dm:1']);
  store.setUpdateState('global-difference', 'pts:100');
  assert.equal(store.getUpdateState('global-difference'), 'pts:100');
  store.createImport('dm:1', 5);
  store.setHealth('connected');
  const health = store.getHealth();
  assert.equal(health.state, 'connected');
  assert.equal(health.selectedChats, 1);
  assert.equal(health.activeChatTitle, 'Alice');
  assert.equal(health.totalMessages, 5);
});

test('removeChatArchive deletes the chat and returns only unreferenced blob hashes', () => {
  const { db, store } = freshStore();
  store.upsertDialog({ peerKey: 'dm:1', kind: 'dm', title: 'Alice', selected: true });
  store.upsertDialog({ peerKey: 'dm:2', kind: 'dm', title: 'Bob', selected: true });
  store.applyMessages(
    [{ ...makeMessage('shared media'), media: [{ mediaKey: 'm1', kind: 'photo', descriptorJson: '{}' }] }],
    'live',
  );
  store.applyMessages(
    [
      {
        ...makeMessage('other media'),
        peerKey: 'dm:2',
        media: [{ mediaKey: 'm2', kind: 'photo', descriptorJson: '{}' }],
      },
    ],
    'live',
  );
  db.prepare(`UPDATE tg_media SET blob_hash='shared' WHERE media_key='m1'`).run();
  db.prepare(
    `INSERT INTO tg_media(media_key,peer_key,message_id,kind,descriptor_json,blob_hash,status)
     VALUES('m1b','dm:2',7,'photo','{}','shared','done')`,
  ).run();
  db.prepare(`UPDATE tg_media SET blob_hash='exclusive' WHERE media_key='m2'`).run();

  const orphaned = store.removeChatArchive('dm:1');
  assert.deepEqual(orphaned, []);
  assert.equal(store.getChat('dm:1'), undefined);
  assert.equal(
    (db.prepare(`SELECT COUNT(1) AS n FROM tg_messages WHERE peer_key='dm:1'`).get() as { n: number }).n,
    0,
  );

  // dm:2's own media m1b ('shared') and m2 ('exclusive') are both cascade-deleted here,
  // and since dm:1's m1 was already removed above, 'shared' is now unreferenced too.
  const orphaned2 = store.removeChatArchive('dm:2');
  assert.deepEqual(orphaned2.sort(), ['exclusive', 'shared']);
});
