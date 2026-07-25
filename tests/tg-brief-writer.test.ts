import './env.js';

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { TelegramArchiveQuery } from '../src/connectors/telegram/archiveQuery.js';
import { TelegramArchiveStore } from '../src/connectors/telegram/archiveStore.js';
import {
  applyApproval,
  chatSlug,
  upsertMemoryPointer,
} from '../src/connectors/telegram/briefWriter.js';
import { TelegramProjectStore } from '../src/connectors/telegram/projectStore.js';
import { migrateDb } from '../src/db.js';
import type { TelegramMessage } from '../src/connectors/telegram/types.js';

const msg = (id: number, text: string): TelegramMessage => ({
  peerKey: 'group:1',
  messageId: id,
  senderName: 'Dev',
  sentAt: '2026-01-01T00:00:00.000Z',
  text,
  entitiesJson: '[]',
  reactionsJson: '[]',
  media: [],
  links: [],
});

test('chatSlug kebab-cases titles', () => {
  assert.equal(chatSlug('Morian Labs build chat'), 'morian-labs-build-chat');
});

test('applyApproval writes brief under wiki project and one memory line', () => {
  const wiki = mkdtempSync(path.join(tmpdir(), 'wiki-'));
  const memoryDir = path.join(wiki, 'memory');
  mkdirSync(path.join(wiki, 'morianlabs'), { recursive: true });
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(path.join(memoryDir, 'MEMORY.md'), '# Memory index\n\n');
  const db = new DatabaseSync(':memory:');
  migrateDb(db);
  const archive = new TelegramArchiveStore(db);
  archive.upsertDialog({
    peerKey: 'group:1',
    kind: 'group',
    title: 'Morian Labs',
    username: 'morianchat',
    selected: true,
  });
  archive.applyMessages(
    [msg(10, 'We decided the duck chassis uses aluminum plates next week')],
    'backfill',
  );
  const projects = new TelegramProjectStore(db);
  const proposal = projects.enqueueProposal({
    peerKey: 'group:1',
    wikiProject: 'morianlabs',
    evidence: 'title',
    score: 1,
    fingerprint: 'fp',
  })!;
  const query = new TelegramArchiveQuery(archive);
  const result = applyApproval({
    proposalId: proposal.id,
    projects,
    query,
    archive,
    wikiDir: wiki,
    memoryDir,
  });
  assert.equal(result.briefPath, 'morianlabs/telegram-morian-labs.md');
  const brief = readFileSync(path.join(wiki, result.briefPath), 'utf8');
  assert.match(brief, /telegram-/);
  assert.match(brief, /chassis|aluminum|duck/i);
  assert.match(brief, /t\.me|group:1#10/);
  assert.doesNotMatch(brief, /lol|haha/);
  const memory = readFileSync(path.join(memoryDir, 'MEMORY.md'), 'utf8');
  assert.match(memory, /morianlabs/);
  assert.equal([...memory.matchAll(/morianlabs/g)].length, 1);
  upsertMemoryPointer(memoryDir, 'morianlabs', 'Morian Duck');
  const memory2 = readFileSync(path.join(memoryDir, 'MEMORY.md'), 'utf8');
  assert.equal(
    [...memory2.matchAll(/^- /gm)].filter((m) => memory2.includes('morianlabs')).length >= 1,
    true,
  );
  assert.ok((memory2.match(/wiki\/morianlabs/g) ?? []).length <= 1);
});

test('applyApproval writes memory before approve; approve failure leaves memory, deletes brief', () => {
  const wiki = mkdtempSync(path.join(tmpdir(), 'wiki-'));
  const memoryDir = path.join(wiki, 'memory');
  mkdirSync(path.join(wiki, 'morianlabs'), { recursive: true });
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(path.join(memoryDir, 'MEMORY.md'), '# Memory index\n\n');
  const db = new DatabaseSync(':memory:');
  migrateDb(db);
  const archive = new TelegramArchiveStore(db);
  archive.upsertDialog({
    peerKey: 'group:1',
    kind: 'group',
    title: 'Morian Labs',
    selected: true,
  });
  const projects = new TelegramProjectStore(db);
  const proposal = projects.enqueueProposal({
    peerKey: 'group:1',
    wikiProject: 'morianlabs',
    evidence: 'title',
    score: 1,
    fingerprint: 'fp',
  })!;
  const query = new TelegramArchiveQuery(archive);
  const originalApprove = projects.approveProposal.bind(projects);
  projects.approveProposal = () => {
    throw new Error('approve failed');
  };
  assert.throws(
    () =>
      applyApproval({
        proposalId: proposal.id,
        projects,
        query,
        archive,
        wikiDir: wiki,
        memoryDir,
      }),
    /approve failed/,
  );
  projects.approveProposal = originalApprove;
  assert.equal(projects.getProposal(proposal.id)?.state, 'pending');
  assert.equal(projects.getMapping('group:1'), undefined);
  const memory = readFileSync(path.join(memoryDir, 'MEMORY.md'), 'utf8');
  assert.match(memory, /morianlabs/);
  assert.equal(
    existsSync(path.join(wiki, 'morianlabs/telegram-morian-labs.md')),
    false,
  );
});

test('reject leaves wiki and memory untouched', () => {
  const wiki = mkdtempSync(path.join(tmpdir(), 'wiki-'));
  const memoryDir = path.join(wiki, 'memory');
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(path.join(memoryDir, 'MEMORY.md'), '# Memory index\n');
  const before = readFileSync(path.join(memoryDir, 'MEMORY.md'), 'utf8');
  const db = new DatabaseSync(':memory:');
  migrateDb(db);
  const archive = new TelegramArchiveStore(db);
  archive.upsertDialog({ peerKey: 'group:1', kind: 'group', title: 'Morian', selected: true });
  const projects = new TelegramProjectStore(db);
  const p = projects.enqueueProposal({
    peerKey: 'group:1',
    wikiProject: 'morianlabs',
    evidence: 'x',
    score: 1,
    fingerprint: 'fp',
  })!;
  projects.rejectProposal(p.id);
  assert.equal(readFileSync(path.join(memoryDir, 'MEMORY.md'), 'utf8'), before);
  assert.equal(projects.getMapping('group:1'), undefined);
});
