import '../../env.js';

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { matchChatToProjects } from '../../../src/modules/tg-archive/proposalEngine.js';
import { listWikiProjects } from '../../../src/modules/tg-archive/wikiProjects.js';

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
