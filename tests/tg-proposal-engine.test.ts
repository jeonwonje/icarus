import './env.js';

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { TelegramArchiveStore } from '../src/connectors/telegram/archiveStore.js';
import { TelegramProjectStore } from '../src/connectors/telegram/projectStore.js';
import {
  matchChatToProjects,
  ProposalEngine,
} from '../src/connectors/telegram/proposalEngine.js';
import { listWikiProjects, tokenize } from '../src/connectors/telegram/wikiProjects.js';
import { migrateDb } from '../src/db.js';

test('listWikiProjects reads ### [slug](slug/index.md) headings only', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wiki-'));
  writeFileSync(
    path.join(root, 'index.md'),
    `# Index\n\n### [morianlabs](morianlabs/index.md)\nDuck robot\n\n### [sodion-atlas](sodion-atlas/index.md)\nBattery\n\n## [me](me/index.md)\nPerson\n`,
  );
  const projects = listWikiProjects(root);
  assert.deepEqual(
    projects.map((p) => p.slug),
    ['morianlabs', 'sodion-atlas'],
  );
});

test('considerChat no longer auto-proposes from title overlap', () => {
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
  const engine = new ProposalEngine({
    archive,
    projects,
    wikiDir: root,
  });
  assert.equal(engine.considerChat('group:1'), null);
  assert.equal(projects.listProposals('pending').length, 0);
});

test('matchChatToProjects rejects weak single-token slug substring matches', () => {
  const projects = [
    { slug: 'morianlabs', title: 'Morian Duck' },
    { slug: 'sodion-atlas', title: 'Battery atlas' },
  ];
  assert.equal(
    matchChatToProjects({ title: 'Morian Labs build chat', projects })?.wikiProject,
    'morianlabs',
  );
  assert.equal(matchChatToProjects({ title: 'Labs chat', projects }), null);
  assert.equal(matchChatToProjects({ title: 'Data dump', projects }), null);
});

test('sweep returns empty — mapping is LLM-driven via historical pass', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wiki-'));
  writeFileSync(
    path.join(root, 'index.md'),
    `### [morianlabs](morianlabs/index.md)\nMorian\n`,
  );
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
  const engine = new ProposalEngine({ archive, projects, wikiDir: root });
  assert.equal(engine.sweep().length, 0);
});
