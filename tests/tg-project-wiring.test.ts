import './env.js';

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { PROJECT_SWEEP_JOB } from '../src/config.js';
import { TelegramArchiveStore } from '../src/connectors/telegram/archiveStore.js';
import { ProposalEngine } from '../src/connectors/telegram/proposalEngine.js';
import { TelegramProjectStore } from '../src/connectors/telegram/projectStore.js';
import { runTelegramProjectSweep } from '../src/connectors/telegram/projectSweep.js';
import { migrateDb, openDb, db } from '../src/db.js';
import { fire, seedSystemRows, setEnqueue } from '../src/scheduler/scheduler.js';

test('runTelegramProjectSweep DMs one keyboard per new proposal', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wiki-'));
  writeFileSync(
    path.join(root, 'index.md'),
    `### [morianlabs](morianlabs/index.md)\nMorian Duck\n`,
  );
  const db = new DatabaseSync(':memory:');
  migrateDb(db);
  const archive = new TelegramArchiveStore(db);
  archive.upsertDialog({
    peerKey: 'group:1',
    kind: 'group',
    title: 'Morian Labs build chat',
    selected: true,
  });
  archive.upsertDialog({
    peerKey: 'group:2',
    kind: 'group',
    title: 'Morian Labs ops',
    selected: true,
  });
  const projects = new TelegramProjectStore(db);
  const engine = new ProposalEngine({ archive, projects, wikiDir: root });
  const dms: string[] = [];
  const count = await runTelegramProjectSweep({
    sweep: () => engine.sweep(),
    getChatTitle: (peerKey) => archive.getChat(peerKey)?.title,
    notifyProposal: async (input) => {
      dms.push(`${input.chatTitle}:${input.wikiProject}`);
    },
    markNotified: (id) => projects.markProposalNotified(id),
  });
  assert.equal(count, 2);
  assert.equal(dms.length, 2);
});

test('sweep retries DM for pending proposal with null notified_at without re-enqueue', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wiki-'));
  writeFileSync(
    path.join(root, 'index.md'),
    `### [morianlabs](morianlabs/index.md)\nMorian Duck\n`,
  );
  const db = new DatabaseSync(':memory:');
  migrateDb(db);
  const archive = new TelegramArchiveStore(db);
  archive.upsertDialog({
    peerKey: 'group:1',
    kind: 'group',
    title: 'Morian Labs build chat',
    selected: true,
  });
  const projects = new TelegramProjectStore(db);
  const engine = new ProposalEngine({ archive, projects, wikiDir: root });
  const proposal = projects.enqueueProposal({
    peerKey: 'group:1',
    wikiProject: 'morianlabs',
    evidence: 'prior import',
    score: 1,
    fingerprint: 'fp-retry',
  })!;
  assert.equal(proposal.notifiedAt, undefined);
  const dms: string[] = [];
  const count = await runTelegramProjectSweep({
    sweep: () => engine.sweep(),
    getChatTitle: (peerKey) => archive.getChat(peerKey)?.title,
    notifyProposal: async (input) => {
      dms.push(`${input.id}:${input.chatTitle}`);
    },
    markNotified: (id) => projects.markProposalNotified(id),
  });
  assert.equal(count, 1);
  assert.equal(dms.length, 1);
  assert.equal(dms[0], `${proposal.id}:Morian Labs build chat`);
  assert.equal(projects.listProposals('pending').length, 1);
  assert.ok(projects.getProposal(proposal.id)?.notifiedAt);
  dms.length = 0;
  const retryCount = await runTelegramProjectSweep({
    sweep: () => engine.sweep(),
    getChatTitle: (peerKey) => archive.getChat(peerKey)?.title,
    notifyProposal: async (input) => {
      dms.push(String(input.id));
    },
    markNotified: (id) => projects.markProposalNotified(id),
  });
  assert.equal(retryCount, 0);
  assert.equal(dms.length, 0);
});

test('seedSystemRows inserts weekly project sweep job', () => {
  openDb();
  db.prepare('DELETE FROM schedules WHERE name=?').run(PROJECT_SWEEP_JOB);
  seedSystemRows();
  const row = db.prepare('SELECT name,cron,prompt FROM schedules WHERE name=?').get(PROJECT_SWEEP_JOB) as
    | { name: string; cron: string; prompt: string }
    | undefined;
  assert.ok(row);
  assert.equal(row.cron, '0 9 * * 1');
  assert.match(row.prompt, /proposalEngine\.sweep/);
});

test('fire on project sweep does not enqueue an agent turn', async () => {
  openDb();
  db.prepare('DELETE FROM schedules WHERE name=?').run(PROJECT_SWEEP_JOB);
  seedSystemRows();
  const row = db.prepare('SELECT id FROM schedules WHERE name=?').get(PROJECT_SWEEP_JOB) as { id: number };
  let enqueued = 0;
  setEnqueue(() => {
    enqueued += 1;
  });
  fire(row.id);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(enqueued, 0);
});
