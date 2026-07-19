import './env.js';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildMemoryBlock, MEMORY_CAP, scaffoldMemory } from '../src/agent/memory.js';

const fresh = () => mkdtempSync(path.join(tmpdir(), 'icarus-mem-'));

test('missing dir or index yields null', () => {
  assert.equal(buildMemoryBlock(path.join(fresh(), 'nope')), null);
});

test('scaffold seeds MEMORY.md once and the block wraps it', () => {
  const dir = fresh();
  scaffoldMemory(dir);
  const block = buildMemoryBlock(dir);
  assert.ok(block?.startsWith(`<memory dir="${dir}">`));
  assert.ok(block?.endsWith('</memory>'));
  writeFileSync(path.join(dir, 'MEMORY.md'), 'custom');
  scaffoldMemory(dir); // must not overwrite
  assert.match(buildMemoryBlock(dir)!, /custom/);
});

test('oversized index is truncated with a warning', () => {
  const dir = fresh();
  scaffoldMemory(dir);
  writeFileSync(path.join(dir, 'MEMORY.md'), 'x'.repeat(MEMORY_CAP + 500));
  const block = buildMemoryBlock(dir)!;
  assert.ok(block.length < MEMORY_CAP + 300);
  assert.match(block, /truncated/);
});
