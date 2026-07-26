import '../../env.js';

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { TelegramArchiveQuery } from '../../../src/modules/tg-archive/archiveQuery.js';
import { TelegramHistoricalPass } from '../../../src/modules/tg-archive/historicalPass.js';
import type { TurnJob } from '../../../src/queue.js';
import { freshArchive, message } from './tg-test-helpers.js';

test('enqueue submits a job and sets state', () => {
  const { store } = freshArchive();
  store.upsertDialog({
    peerKey: 'group:1',
    kind: 'group',
    title: 'Project chat',
    selected: true,
  });
  for (let id = 1; id <= 5; id++) {
    store.applyMessages([message('group:1', id, `msg ${id}`)], 'backfill');
  }

  const jobs: Omit<TurnJob, 'enqueuedAt' | 'ac'>[] = [];
  const pass = new TelegramHistoricalPass({
    store,
    query: new TelegramArchiveQuery(store),
    submit: (job) => jobs.push(job),
    applyOutput: () => ({
      digest: '',
      mappingProposal: null,
      appended: 0,
      approvalNotices: [],
      alerts: [],
    }),
    notifyDigest: async () => {},
    notifyMapping: async () => {},
    notifyApprovals: async () => {},
    listWikiProjects: () => [],
    getMapping: () => undefined,
  });

  pass.enqueue('group:1');
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.jid, 'job:tg-historical:group-1');
  assert.equal(jobs[0]!.kind, 'job:tg-historical');

  const raw = store.getUpdateState('historical-pass:group:1');
  assert.ok(raw);
  const state = JSON.parse(raw!) as { phase: string; digestParts: string[] };
  assert.equal(state.phase, 'mapping');
  assert.deepEqual(state.digestParts, []);
});

test('resume after partial cursor', async () => {
  const { store } = freshArchive();
  store.upsertDialog({
    peerKey: 'group:1',
    kind: 'group',
    title: 'Long chat',
    selected: true,
  });
  for (let id = 1; id <= 60; id++) {
    store.applyMessages([message('group:1', id, `msg ${id}`)], 'backfill');
  }

  const jobs: Omit<TurnJob, 'enqueuedAt' | 'ac'>[] = [];
  const digests: string[] = [];
  const pass = new TelegramHistoricalPass({
    store,
    query: new TelegramArchiveQuery(store),
    submit: (job) => jobs.push(job),
    applyOutput: () => ({
      digest: 'chunk',
      mappingProposal: null,
      appended: 0,
      approvalNotices: [],
      alerts: [],
    }),
    notifyDigest: async (text) => {
      digests.push(text);
    },
    notifyMapping: async () => {},
    notifyApprovals: async () => {},
    listWikiProjects: () => [],
    getMapping: () => undefined,
  });

  store.setUpdateState(
    'historical-pass:group:1',
    JSON.stringify({ phase: 'content', cursorMessageId: 11, digestParts: ['prior'] }),
  );

  pass.enqueue('group:1');
  assert.equal(jobs.length, 1);
  const prompt = jobs[0]!.lines[0]!.text;
  assert.match(prompt, /#10\b/);
  assert.doesNotMatch(prompt, /#11\b/);

  jobs[0]!.onDone!({ status: 'ok', finalText: '{"digest":"","facts":[],"spill":[],"approvals":[]}' });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const doneRaw = store.getUpdateState('historical-pass:group:1');
  assert.ok(doneRaw);
  const done = JSON.parse(doneRaw!) as { phase: string; digestParts: string[] };
  assert.equal(done.phase, 'done');
  assert.deepEqual(done.digestParts, ['prior', 'chunk']);
  assert.equal(digests.length, 1);
  assert.equal(digests[0], 'prior\n\nchunk');
});

test('catch-up skips chats already done', () => {
  const { store } = freshArchive();
  store.upsertDialog({
    peerKey: 'group:1',
    kind: 'group',
    title: 'Done chat',
    selected: true,
  });
  store.upsertDialog({
    peerKey: 'group:2',
    kind: 'group',
    title: 'Pending chat',
    selected: true,
  });
  store.applyMessages([message('group:1', 1, 'a'), message('group:2', 1, 'b')], 'backfill');
  store.setUpdateState(
    'historical-pass:group:1',
    JSON.stringify({ phase: 'done', digestParts: [] }),
  );

  const jobs: Omit<TurnJob, 'enqueuedAt' | 'ac'>[] = [];
  const pass = new TelegramHistoricalPass({
    store,
    query: new TelegramArchiveQuery(store),
    submit: (job) => jobs.push(job),
    applyOutput: () => ({
      digest: '',
      mappingProposal: null,
      appended: 0,
      approvalNotices: [],
      alerts: [],
    }),
    notifyDigest: async () => {},
    notifyMapping: async () => {},
    notifyApprovals: async () => {},
    listWikiProjects: () => [],
    getMapping: () => undefined,
  });

  pass.enqueueCatchUp();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.jid, 'job:tg-historical:group-2');
});

test('enqueue with wiki projects includes FTS section in prompt', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wiki-hist-'));
  writeFileSync(
    path.join(root, 'index.md'),
    `### [morianlabs](morianlabs/index.md)\nMorian Duck\n`,
  );
  const { store } = freshArchive();
  store.upsertDialog({
    peerKey: 'group:1',
    kind: 'group',
    title: 'Morian Labs',
    selected: true,
  });
  store.applyMessages(
    [message('group:1', 1, 'morianlabs prototype shipped')],
    'backfill',
  );

  const jobs: Omit<TurnJob, 'enqueuedAt' | 'ac'>[] = [];
  const pass = new TelegramHistoricalPass({
    store,
    query: new TelegramArchiveQuery(store),
    submit: (job) => jobs.push(job),
    applyOutput: () => ({
      digest: '',
      mappingProposal: null,
      appended: 0,
      approvalNotices: [],
      alerts: [],
    }),
    notifyDigest: async () => {},
    notifyMapping: async () => {},
    notifyApprovals: async () => {},
    listWikiProjects: () => [{ slug: 'morianlabs', title: 'Morian Duck' }],
    getMapping: () => undefined,
  });

  pass.enqueue('group:1');
  assert.match(jobs[0]!.lines[0]!.text, /Archive FTS hits/);
  assert.match(jobs[0]!.lines[0]!.text, /morianlabs/);
});
