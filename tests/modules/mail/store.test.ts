import '../../env.js';

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { migrateDb } from '../../../src/db.js';
import { MailStore, type CensusMessageInput } from '../../../src/modules/mail/store.js';

function freshStore(): MailStore {
  const db = new DatabaseSync(':memory:');
  migrateDb(db);
  let n = 0;
  return new MailStore(db, () => `2026-07-26T00:00:${String(n++).padStart(2, '0')}.000Z`);
}

function msg(key: string, over: Partial<CensusMessageInput> = {}): CensusMessageInput {
  return {
    messageKey: key,
    folderPath: '[0]',
    folderName: 'Inbox',
    childIndex: 0,
    sentAt: '2026-07-20T00:00:00.000Z',
    senderName: 'Prof X',
    senderEmail: 'x@u.edu',
    recipients: 'jeon@u.edu',
    subject: `subject ${key}`,
    attachmentCount: 0,
    ...over,
  };
}

describe('MailStore', () => {
  it('creates exports and dedups by file signature', () => {
    const s = freshStore();
    const e = s.createExport({ fileSig: 'a.pst|10|1', fileName: 'a.pst', filePath: 'C:/a.pst', bytes: 10 });
    assert.equal(e.state, 'census');
    assert.equal(e.scannedMessages, 0);
    assert.equal(s.getExportBySig('a.pst|10|1')?.id, e.id);
    assert.equal(s.getExportBySig('missing'), undefined);
    assert.throws(() =>
      s.createExport({ fileSig: 'a.pst|10|1', fileName: 'a.pst', filePath: 'C:/a.pst', bytes: 10 }),
    );
  });

  it('inserts messages idempotently and tracks the cursor', () => {
    const s = freshStore();
    const e = s.createExport({ fileSig: 'sig', fileName: 'a.pst', filePath: 'C:/a.pst', bytes: 10 });
    assert.equal(s.insertMessages(e.id, [msg('k1'), msg('k2')]), 2);
    assert.equal(s.insertMessages(e.id, [msg('k1'), msg('k3')]), 1, 're-inserting k1 is a no-op');
    assert.equal(s.countByState(e.id, 'new'), 3);

    s.saveCursor(e.id, '{"childIndex":7}', 3);
    const after = s.getExport(e.id)!;
    assert.equal(after.cursorJson, '{"childIndex":7}');
    assert.equal(after.scannedMessages, 3);
  });

  it('claims for ranking, applies ranks, and splits on the threshold', () => {
    const s = freshStore();
    const e = s.createExport({ fileSig: 'sig', fileName: 'a.pst', filePath: 'C:/a.pst', bytes: 10 });
    s.insertMessages(e.id, [msg('k1'), msg('k2'), msg('k3')]);

    const claimed = s.claimMessagesForRanking(2);
    assert.equal(claimed.length, 2);
    assert.equal(s.countByState(e.id, 'ranking'), 2);
    assert.equal(s.countByState(e.id, 'new'), 1, 'unclaimed row stays available');

    s.applyRank({ id: claimed[0].id, rank: 3, reason: 'deadline', source: 'model', state: 'ranked' });
    s.applyRank({ id: claimed[1].id, rank: 0, reason: 'marketing', source: 'model', state: 'skipped' });

    const triage = s.claimMessagesForTriage(10, 2);
    assert.equal(triage.length, 1);
    assert.equal(triage[0].rank, 3);
    assert.equal(s.getMessage(claimed[1].id)!.state, 'skipped', 'below-threshold never re-surfaces');
  });

  it('ranks a whole sender in one statement', () => {
    const s = freshStore();
    const e = s.createExport({ fileSig: 'sig', fileName: 'a.pst', filePath: 'C:/a.pst', bytes: 10 });
    s.insertMessages(e.id, [
      msg('k1', { senderEmail: 'noreply@spam.com' }),
      msg('k2', { senderEmail: 'noreply@spam.com' }),
      msg('k3', { senderEmail: 'x@u.edu' }),
    ]);

    const n = s.applyRankBySender({
      email: 'noreply@spam.com',
      rank: 0,
      reason: 'bulk marketing',
      source: 'sender',
      state: 'skipped',
    });
    assert.equal(n, 2);
    assert.equal(s.countByState(e.id, 'skipped'), 2);
    assert.equal(s.countByState(e.id, 'new'), 1);
  });

  it('releases claims and parks a row after three attempts', () => {
    const s = freshStore();
    const e = s.createExport({ fileSig: 'sig', fileName: 'a.pst', filePath: 'C:/a.pst', bytes: 10 });
    s.insertMessages(e.id, [msg('k1')]);
    const id = s.claimMessagesForRanking(1)[0].id;

    s.releaseMessages([id], 'new', 'rank_failed');
    assert.equal(s.getMessage(id)!.state, 'new');
    assert.equal(s.getMessage(id)!.attempts, 1);

    s.releaseMessages([id], 'new', 'rank_failed');
    assert.equal(s.getMessage(id)!.state, 'new');

    s.releaseMessages([id], 'new', 'rank_failed');
    assert.equal(s.getMessage(id)!.state, 'rank_failed', 'third strike parks it');
  });

  it('resetStaleClaims returns crashed claims to the pool', () => {
    const s = freshStore();
    const e = s.createExport({ fileSig: 'sig', fileName: 'a.pst', filePath: 'C:/a.pst', bytes: 10 });
    s.insertMessages(e.id, [msg('k1'), msg('k2')]);
    const claimed = s.claimMessagesForRanking(1)[0];
    s.applyRank({ id: claimed.id, rank: 3, reason: 'x', source: 'model', state: 'ranked' });
    s.claimMessagesForTriage(1, 2);
    s.claimMessagesForRanking(1);

    const reset = s.resetStaleClaims();
    assert.deepEqual(reset, { ranking: 1, queued: 1 });
    assert.equal(s.countByState(e.id, 'new'), 1);
    assert.equal(s.countByState(e.id, 'ranked'), 1);
  });

  it('claimSendersForVerdict groups unranked mail and skips senders already judged', () => {
    const s = freshStore();
    const e = s.createExport({ fileSig: 'sig', fileName: 'a.pst', filePath: 'C:/a.pst', bytes: 10 });
    s.insertMessages(e.id, [
      msg('k1', { senderEmail: 'bulk@x.com', subject: 'one' }),
      msg('k2', { senderEmail: 'bulk@x.com', subject: 'two' }),
      msg('k3', { senderEmail: 'prof@u.edu', subject: 'three' }),
    ]);

    let senders = s.claimSendersForVerdict(10);
    assert.equal(senders.length, 2);
    assert.equal(senders[0].email, 'bulk@x.com', 'busiest sender first');
    assert.equal(senders[0].n, 2);
    assert.deepEqual(senders[0].subjects.sort(), ['one', 'two']);

    s.upsertSender({
      email: 'bulk@x.com',
      displayName: 'Bulk',
      verdict: 'noise',
      why: 'marketing',
      source: 'model',
    });
    senders = s.claimSendersForVerdict(10);
    assert.deepEqual(senders.map((x) => x.email), ['prof@u.edu'], 'judged senders drop out');
  });

  it('upsertSender overwrites a verdict and setSenderVerdict marks it owner-authored', () => {
    const s = freshStore();
    s.upsertSender({ email: 'a@b.c', displayName: 'A', verdict: 'noise', why: 'w', source: 'model' });
    const first = s.getSender('a@b.c')!;
    assert.equal(first.verdict, 'noise');
    assert.equal(first.source, 'model');

    s.setSenderVerdict(first.id, 'relevant');
    const second = s.getSender('a@b.c')!;
    assert.equal(second.verdict, 'relevant');
    assert.equal(second.source, 'owner');
    assert.deepEqual(s.senderCounts(), { model: 0, owner: 1 });
  });

  it('records filings and links, and counts filings since a timestamp', () => {
    const s = freshStore();
    const e = s.createExport({ fileSig: 'sig', fileName: 'a.pst', filePath: 'C:/a.pst', bytes: 10 });
    s.insertMessages(e.id, [msg('k1')]);
    const id = s.getMessage(1)!.id;

    s.recordFiled({
      messageId: id,
      kind: 'attachment',
      project: 'general',
      displayName: 'ps3.pdf',
      destPath: 'C:/Desktop/3_General/2026-07-26_ps3.pdf',
      sha256: 'a'.repeat(64),
      reused: 0,
      why: 'coursework',
    });
    s.recordLink({ messageId: id, url: 'https://x/y', title: 'Y', project: 'general', why: 'portal' });
    s.recordLink({ messageId: id, url: 'https://x/y', title: 'Y', project: 'general', why: 'dupe' });

    assert.equal(s.listFiled(10, 0).length, 1);
    assert.equal(s.listLinks(10, 0).length, 1, 'same url on same message is ignored');
    assert.equal(s.filedSince('2026-07-26T00:00:00.000Z'), 1);
    assert.equal(s.filedSince('2027-01-01T00:00:00.000Z'), 0);
    assert.equal(s.counts().filed, 1);
  });

  it('tracks export state, attempts, and the active set', () => {
    const s = freshStore();
    const e = s.createExport({ fileSig: 'sig', fileName: 'a.pst', filePath: 'C:/a.pst', bytes: 10 });
    assert.equal(s.activeExports().length, 1);

    assert.equal(s.bumpExportAttempts(e.id, 'boom'), 1);
    assert.equal(s.bumpExportAttempts(e.id, 'boom'), 2);
    s.clearExportAttempts(e.id);
    assert.equal(s.getExport(e.id)!.attempts, 0);
    assert.equal(s.getExport(e.id)!.lastError, null);

    s.setExportState(e.id, 'done');
    assert.equal(s.activeExports().length, 0);
    assert.ok(s.getExport(e.id)!.completedAt, 'done stamps completedAt');
  });
});
