import '../../env.js';

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { TelegramArchiveStore } from '../../../src/modules/tg-archive/archiveStore.js';
import { TelegramProjectStore } from '../../../src/modules/tg-archive/projectStore.js';
import type { TriageOutput } from '../../../src/modules/tg-archive/triageOutput.js';
import { WikiFactWriter } from '../../../src/modules/tg-archive/wikiFactWriter.js';
import { migrateDb } from '../../../src/db.js';

const wikiIndex = (slugs: string[]) =>
  slugs.map((s) => `### [${s}](${s}/index.md)\n${s} project`).join('\n\n');

const setup = (slugs: string[]) => {
  const wikiDir = mkdtempSync(path.join(tmpdir(), 'wiki-'));
  writeFileSync(path.join(wikiDir, 'index.md'), wikiIndex(slugs));
  for (const slug of slugs) mkdirSync(path.join(wikiDir, slug), { recursive: true });
  const db = new DatabaseSync(':memory:');
  migrateDb(db);
  const archive = new TelegramArchiveStore(db);
  const projects = new TelegramProjectStore(db);
  const writer = new WikiFactWriter({
    wikiDir,
    projects,
    archive,
    wikiProjectSlugs: () => slugs,
  });
  return { wikiDir, archive, projects, writer };
};

const upsertChat = (archive: TelegramArchiveStore, peerKey: string, title = 'Chat') => {
  archive.upsertDialog({ peerKey, kind: 'group', title, selected: true });
};

const approveMapping = (
  projects: TelegramProjectStore,
  peerKey: string,
  wikiProject: string,
  briefPath: string,
) => {
  const proposal = projects.enqueueProposal({
    peerKey,
    wikiProject,
    evidence: 'x',
    score: 1,
    fingerprint: `fp-${peerKey}`,
  })!;
  projects.approveProposal(proposal.id, briefPath);
};

const writeBrief = (wikiDir: string, briefRel: string, body = '') => {
  const full = path.join(wikiDir, briefRel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(
    full,
    body ||
      `# Telegram brief\n\nMapped chat.\n\n## Notes\n- seed note — group:1#1\n`,
    'utf8',
  );
};

test('mapped peer appends facts to sticky brief', () => {
  const { wikiDir, archive, projects, writer } = setup(['morianlabs']);
  upsertChat(archive, 'group:1', 'Trip chat');
  writeBrief(wikiDir, 'morianlabs/telegram-trip-chat.md');
  approveMapping(projects, 'group:1', 'morianlabs', 'morianlabs/telegram-trip-chat.md');

  const output: TriageOutput = {
    digest: '▸ chassis update',
    facts: [{ project: 'morianlabs', claim: 'Aluminum plates ship Monday', cite: [42] }],
    spill: [],
    approvals: [],
  };
  const result = writer.apply('group:1', output);

  assert.equal(result.appended, 1);
  assert.equal(result.approvalNotices.length, 0);
  const brief = readFileSync(path.join(wikiDir, 'morianlabs/telegram-trip-chat.md'), 'utf8');
  assert.match(brief, /Aluminum plates ship Monday/);
  assert.match(brief, /group:1#42/);
  assert.match(brief, /seed note/);
});

test('unmapped peer blocks auto facts', () => {
  const { wikiDir, writer } = setup(['morianlabs']);
  writeBrief(wikiDir, 'morianlabs/telegram-other.md');

  const result = writer.apply('group:1', {
    digest: '▸ note',
    facts: [{ project: 'morianlabs', claim: 'Should not land', cite: [1] }],
    spill: [],
    approvals: [],
  });

  assert.equal(result.appended, 0);
  const brief = readFileSync(path.join(wikiDir, 'morianlabs/telegram-other.md'), 'utf8');
  assert.doesNotMatch(brief, /Should not land/);
});

test('spill to project without brief yields new_page approval', () => {
  const { writer } = setup(['morianlabs', 'sodion-atlas']);

  const result = writer.apply('group:1', {
    digest: '',
    facts: [],
    spill: [{ project: 'sodion-atlas', claim: 'Battery spec locked', cite: [9] }],
    approvals: [],
  });

  assert.equal(result.appended, 0);
  assert.equal(result.approvalNotices.length, 1);
  assert.match(result.approvalNotices[0]!, /new_page/);
  assert.match(result.approvalNotices[0]!, /Battery spec locked/);
});

test('spill appends when target project has mapped brief', () => {
  const { wikiDir, archive, projects, writer } = setup(['morianlabs', 'sodion-atlas']);
  upsertChat(archive, 'group:1');
  upsertChat(archive, 'group:2', 'Atlas chat');
  writeBrief(wikiDir, 'sodion-atlas/telegram-atlas-chat.md');
  approveMapping(projects, 'group:2', 'sodion-atlas', 'sodion-atlas/telegram-atlas-chat.md');

  const result = writer.apply('group:1', {
    digest: '',
    facts: [],
    spill: [{ project: 'sodion-atlas', claim: 'Cell chemistry confirmed', cite: [55] }],
    approvals: [],
  });

  assert.equal(result.appended, 1);
  const brief = readFileSync(path.join(wikiDir, 'sodion-atlas/telegram-atlas-chat.md'), 'utf8');
  assert.match(brief, /Cell chemistry confirmed/);
  assert.match(brief, /group:1#55/);
});

test('unknown spill slug yields new_project approval', () => {
  const { writer } = setup(['morianlabs']);

  const result = writer.apply('group:1', {
    digest: '',
    facts: [],
    spill: [{ project: 'nope', claim: 'Orphan fact', cite: [1] }],
    approvals: [],
  });

  assert.equal(result.approvalNotices.length, 1);
  assert.match(result.approvalNotices[0]!, /new_project/);
  assert.match(result.approvalNotices[0]!, /nope/);
});

test('unmapped mapping suggestion enqueues proposal without title overlap', () => {
  const { archive, projects, writer } = setup(['morianlabs']);
  upsertChat(archive, 'group:99', 'Vendor thread');

  const evidence = 'messages reference duck chassis cad files';
  const output: TriageOutput = {
    digest: '',
    mapping: { wikiProject: 'morianlabs', evidence, confidence: 'high' },
    facts: [],
    spill: [],
    approvals: [],
  };
  const result = writer.apply('group:99', output);

  assert.ok(result.mappingProposal);
  assert.equal(result.mappingProposal!.wikiProject, 'morianlabs');
  assert.equal(result.mappingProposal!.evidence, evidence);
  assert.equal(
    result.mappingProposal!.fingerprint,
    createHash('sha256').update(`morianlabs:${evidence}`).digest('hex').slice(0, 16),
  );
  assert.equal(projects.getPendingForPeer('group:99')?.id, result.mappingProposal!.id);
});

test('unknown mapping slug yields new_project and does not enqueue', () => {
  const { archive, projects, writer } = setup(['morianlabs']);
  upsertChat(archive, 'group:1');

  const result = writer.apply('group:1', {
    digest: '',
    mapping: { wikiProject: 'unknown-co', evidence: 'vendor thread', confidence: 'medium' },
    facts: [],
    spill: [],
    approvals: [],
  });

  assert.equal(result.mappingProposal, null);
  assert.equal(projects.getPendingForPeer('group:1'), undefined);
  assert.match(result.approvalNotices[0]!, /new_project/);
  assert.match(result.approvalNotices[0]!, /unknown-co/);
});

test('output approvals become notices without file writes', () => {
  const { wikiDir, archive, projects, writer } = setup(['morianlabs']);
  upsertChat(archive, 'group:1');
  writeBrief(wikiDir, 'morianlabs/telegram-mapped.md');
  approveMapping(projects, 'group:1', 'morianlabs', 'morianlabs/telegram-mapped.md');
  const before = readFileSync(path.join(wikiDir, 'morianlabs/telegram-mapped.md'), 'utf8');

  const result = writer.apply('group:1', {
    digest: '',
    facts: [],
    spill: [],
    approvals: [
      {
        kind: 'memory',
        summary: 'Add MEMORY pointer for vendor chat',
        draft: '- **Vendor** — wiki/morianlabs/',
      },
    ],
  });

  assert.equal(result.approvalNotices.length, 1);
  assert.match(result.approvalNotices[0]!, /memory/);
  assert.match(result.approvalNotices[0]!, /MEMORY pointer/);
  assert.equal(
    readFileSync(path.join(wikiDir, 'morianlabs/telegram-mapped.md'), 'utf8'),
    before,
  );
});

test('append creates Notes section when missing', () => {
  const { wikiDir, archive, projects, writer } = setup(['morianlabs']);
  upsertChat(archive, 'group:1');
  writeBrief(wikiDir, 'morianlabs/telegram-plain.md', '# Telegram brief\n\nNo notes yet.\n');
  approveMapping(projects, 'group:1', 'morianlabs', 'morianlabs/telegram-plain.md');

  writer.apply('group:1', {
    digest: '',
    facts: [{ project: 'morianlabs', claim: 'New durable fact', cite: [7] }],
    spill: [],
    approvals: [],
  });

  const brief = readFileSync(path.join(wikiDir, 'morianlabs/telegram-plain.md'), 'utf8');
  assert.match(brief, /## Notes/);
  assert.match(brief, /New durable fact — group:1#7/);
});

test('unknown fact slug on mapped peer yields new_project not append', () => {
  const { wikiDir, archive, projects, writer } = setup(['morianlabs']);
  upsertChat(archive, 'group:1');
  writeBrief(wikiDir, 'morianlabs/telegram-mapped.md');
  approveMapping(projects, 'group:1', 'morianlabs', 'morianlabs/telegram-mapped.md');

  const result = writer.apply('group:1', {
    digest: '',
    facts: [{ project: 'ghost-project', claim: 'Should not append', cite: [1] }],
    spill: [],
    approvals: [],
  });

  assert.equal(result.appended, 0);
  assert.match(result.approvalNotices[0]!, /new_project/);
  const brief = readFileSync(path.join(wikiDir, 'morianlabs/telegram-mapped.md'), 'utf8');
  assert.doesNotMatch(brief, /Should not append/);
});
