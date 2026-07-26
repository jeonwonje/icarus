import '../../env.js';

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { migrateDb } from '../../../src/db.js';
import { MailStore, type CensusMessageInput } from '../../../src/modules/mail/store.js';
import { DEFAULT_POLICY, rankForVerdict, runRankPass, runSenderPass } from '../../../src/modules/mail/rank.js';
import { extractJson, parseRankOutput, parseSenderOutput } from '../../../src/modules/mail/rankOutput.js';

function seeded(rows: CensusMessageInput[]): { store: MailStore; exportId: number } {
  const db = new DatabaseSync(':memory:');
  migrateDb(db);
  let n = 0;
  const store = new MailStore(db, () => `2026-07-26T00:00:${String(n++).padStart(2, '0')}.000Z`);
  const e = store.createExport({ fileSig: 's', fileName: 'a.pst', filePath: 'C:/a.pst', bytes: 1 });
  store.insertMessages(e.id, rows);
  return { store, exportId: e.id };
}

function msg(key: string, over: Partial<CensusMessageInput> = {}): CensusMessageInput {
  return {
    messageKey: key,
    folderPath: '[0]',
    folderName: 'Inbox',
    childIndex: 0,
    sentAt: '2026-07-20T00:00:00.000Z',
    senderName: 'Sender',
    senderEmail: 'a@b.c',
    recipients: 'jeon@u.edu',
    subject: `subject ${key}`,
    attachmentCount: 0,
    ...over,
  };
}

describe('mail rank output parsing', () => {
  it('extracts JSON from fences, prefixes, and trailing prose', () => {
    assert.equal(extractJson('```json\n{"a":1}\n```'), '{"a":1}');
    assert.equal(extractJson('here you go: {"a":1} hope that helps'), '{"a":1}');
    assert.equal(extractJson('{"a":"}"}'), '{"a":"}"}', 'braces inside strings do not close it');
    assert.equal(extractJson('no json here'), null);
  });

  it('rejects malformed and out-of-range output', () => {
    assert.ok(parseRankOutput('not json').error);
    assert.ok(parseRankOutput('{"ranks":[{"id":1,"rank":9}]}').error, 'rank must be 0-3');
    assert.deepEqual(parseRankOutput('{"ranks":[]}').output, { ranks: [] });
    assert.ok(parseSenderOutput('{"senders":[{"id":1,"verdict":"maybe"}]}').error);
    assert.deepEqual(parseSenderOutput('{"senders":[{"id":1,"verdict":"noise"}]}').output, {
      senders: [{ id: 1, verdict: 'noise', why: '' }],
    });
  });
});

describe('sender pass', () => {
  it('settles noise and relevant senders wholesale and leaves "sometimes" for message ranking', async () => {
    const { store, exportId } = seeded([
      msg('k1', { senderEmail: 'bulk@ads.com' }),
      msg('k2', { senderEmail: 'bulk@ads.com' }),
      msg('k3', { senderEmail: 'prof@u.edu' }),
      msg('k4', { senderEmail: 'list@soc.org' }),
    ]);

    let listed: string[] = [];
    const res = await runSenderPass(store, {
      limit: 10,
      policy: DEFAULT_POLICY,
      classifier: async (prompt) => {
        // ids are positional, so mirror the order the prompt actually listed.
        listed = [...prompt.matchAll(/#\d+ \| .*?<([^>]+)>/g)].map((m) => m[1]);
        return JSON.stringify({
          senders: listed.map((email, i) => ({
            id: i + 1,
            verdict: email === 'bulk@ads.com' ? 'noise' : email === 'prof@u.edu' ? 'relevant' : 'sometimes',
            why: 'x',
          })),
        });
      },
    });

    assert.equal(res.judged, 3);
    assert.equal(res.settled, 3, 'two noise + one relevant');
    assert.equal(store.countByState(exportId, 'skipped'), 2);
    assert.equal(store.countByState(exportId, 'ranked'), 1);
    assert.equal(store.countByState(exportId, 'new'), 1, 'the "sometimes" sender still needs ranking');
    assert.equal(store.getSender('bulk@ads.com')!.hits, 2);
    assert.equal(store.getMessage(3)!.rank, 2, 'a relevant sender means keep, never act');
  });

  it('ignores ids outside the listed range and never double-counts one', async () => {
    const { store } = seeded([msg('k1', { senderEmail: 'real@u.edu' })]);
    const res = await runSenderPass(store, {
      limit: 10,
      policy: DEFAULT_POLICY,
      classifier: async () =>
        JSON.stringify({
          senders: [
            { id: 99, verdict: 'relevant', why: 'invented' },
            { id: 1, verdict: 'noise', why: 'real' },
            { id: 1, verdict: 'relevant', why: 'duplicate' },
          ],
        }),
    });
    assert.equal(res.judged, 1);
    assert.equal(store.getSender('real@u.edu')!.verdict, 'noise', 'first verdict wins, dupe ignored');
  });

  it('reports a parse error without touching any row', async () => {
    const { store, exportId } = seeded([msg('k1')]);
    const res = await runSenderPass(store, {
      limit: 10,
      policy: DEFAULT_POLICY,
      classifier: async () => 'the mailbox looks fine to me',
    });
    assert.ok(res.error);
    assert.equal(store.countByState(exportId, 'new'), 1);
  });

  it('maps verdicts to ranks — relevant is keep, not act', () => {
    assert.deepEqual(rankForVerdict('noise'), { rank: 0, state: 'skipped' });
    assert.deepEqual(rankForVerdict('relevant'), { rank: 2, state: 'ranked' });
    assert.equal(rankForVerdict('sometimes'), null);
  });
});

describe('message rank pass', () => {
  it('splits on the threshold and never re-surfaces what it set aside', async () => {
    const { store, exportId } = seeded([msg('k1'), msg('k2'), msg('k3')]);
    const res = await runRankPass(store, {
      limit: 10,
      policy: DEFAULT_POLICY,
      threshold: 2,
      classifier: async (prompt) => {
        const ids = [...prompt.matchAll(/#(\d+) \|/g)].map((m) => Number(m[1]));
        return JSON.stringify({
          ranks: [
            { id: ids[0], rank: 3, why: 'deadline' },
            { id: ids[1], rank: 2, why: 'document' },
            { id: ids[2], rank: 0, why: 'marketing' },
          ],
        });
      },
    });

    assert.deepEqual({ ranked: res.ranked, skipped: res.skipped, released: res.released }, {
      ranked: 2,
      skipped: 1,
      released: 0,
    });
    assert.equal(store.countByState(exportId, 'ranked'), 2);
    assert.equal(store.countByState(exportId, 'skipped'), 1);
    assert.equal(store.claimMessagesForRanking(10).length, 0, 'nothing left to rank');
  });

  it('releases ids the model omitted so they come back next window', async () => {
    const { store, exportId } = seeded([msg('k1'), msg('k2')]);
    const res = await runRankPass(store, {
      limit: 10,
      policy: DEFAULT_POLICY,
      threshold: 2,
      classifier: async (prompt) => {
        const first = Number(/#(\d+) \|/.exec(prompt)![1]);
        return JSON.stringify({ ranks: [{ id: first, rank: 3, why: 'ok' }] });
      },
    });
    assert.equal(res.ranked, 1);
    assert.equal(res.released, 1);
    assert.equal(store.countByState(exportId, 'new'), 1);
  });

  it('releases the whole window on unparseable output — no fallback rank', async () => {
    const { store, exportId } = seeded([msg('k1'), msg('k2')]);
    const res = await runRankPass(store, {
      limit: 10,
      policy: DEFAULT_POLICY,
      threshold: 2,
      classifier: async () => 'I could not decide',
    });
    assert.ok(res.error);
    assert.equal(res.released, 2);
    assert.equal(store.countByState(exportId, 'new'), 2);
    assert.equal(store.countByState(exportId, 'skipped'), 0, 'nothing silently buried');
    assert.equal(store.countByState(exportId, 'ranked'), 0, 'nothing silently promoted');
  });

  it('releases the window when the classifier throws', async () => {
    const { store, exportId } = seeded([msg('k1')]);
    const res = await runRankPass(store, {
      limit: 10,
      policy: DEFAULT_POLICY,
      threshold: 2,
      classifier: async () => {
        throw new Error('api down');
      },
    });
    assert.match(res.error!, /api down/);
    assert.equal(store.countByState(exportId, 'new'), 1);
  });
});
