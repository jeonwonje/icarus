import '../../env.js';

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { TelegramArchiveStore } from '../../../src/modules/tg-archive/archiveStore.js';
import { TelegramProjectStore } from '../../../src/modules/tg-archive/projectStore.js';
import { migrateDb } from '../../../src/db.js';

const fresh = () => {
  const db = new DatabaseSync(':memory:');
  migrateDb(db);
  const archive = new TelegramArchiveStore(db);
  archive.upsertDialog({ peerKey: 'group:1', kind: 'group', title: 'Morian Labs', selected: true });
  return { db, store: new TelegramProjectStore(db) };
};

test('enqueueProposal is idempotent for pending and unique per peer', () => {
  const { store } = fresh();
  const a = store.enqueueProposal({
    peerKey: 'group:1',
    wikiProject: 'morianlabs',
    evidence: 'title token morian',
    score: 2,
    fingerprint: 'fp1',
  });
  const b = store.enqueueProposal({
    peerKey: 'group:1',
    wikiProject: 'morianlabs',
    evidence: 'title token morian',
    score: 2,
    fingerprint: 'fp1',
  });
  assert.equal(a!.id, b!.id);
  assert.equal(store.listProposals('pending').length, 1);
});

test('reject then enqueue same fingerprint returns null; new fingerprint enqueues', () => {
  const { store } = fresh();
  const p = store.enqueueProposal({
    peerKey: 'group:1',
    wikiProject: 'morianlabs',
    evidence: 'x',
    score: 1,
    fingerprint: 'fp1',
  });
  store.rejectProposal(p!.id);
  assert.equal(
    store.enqueueProposal({
      peerKey: 'group:1',
      wikiProject: 'morianlabs',
      evidence: 'x',
      score: 1,
      fingerprint: 'fp1',
    }),
    null,
  );
  const again = store.enqueueProposal({
    peerKey: 'group:1',
    wikiProject: 'morianlabs',
    evidence: 'y',
    score: 1,
    fingerprint: 'fp2',
  });
  assert.ok(again);
  assert.equal(again!.state, 'pending');
});

test('approveProposal writes mapping and marks proposal approved', () => {
  const { store } = fresh();
  const p = store.enqueueProposal({
    peerKey: 'group:1',
    wikiProject: 'morianlabs',
    evidence: 'x',
    score: 1,
    fingerprint: 'fp1',
  });
  store.approveProposal(p!.id, 'morianlabs/telegram-morian-labs.md');
  assert.equal(store.getMapping('group:1')?.wikiProject, 'morianlabs');
  assert.equal(store.getProposal(p!.id)?.state, 'approved');
});
