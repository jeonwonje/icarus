import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const realCwd = process.cwd();
let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-bootstrap-'));
  process.chdir(tmpRoot);
  // Pin raw/ to a path inside the tmp cwd so tests don't write into (and read
  // back from) the shared default RAW_DIR. Without this, on a host where the
  // default RAW_DIR parent exists, data/raw symlinks to that shared tree and
  // leaks state across tests.
  process.env.RAW_DIR = path.join(tmpRoot, 'raw-src');
  vi.resetModules();
});
afterEach(() => {
  process.chdir(realCwd);
  delete process.env.RAW_DIR;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

async function setup(opts: {
  index?: string;
  log?: string;
  skills?: Record<string, string>;
  rawFiles?: string[];        // paths relative to raw/, e.g. 'a.pdf' or 'receipts/b.pdf'
  oldRawFiles?: string[];     // same, but stamped older than log.md
}) {
  const { ensureDataLayout, dataDir, skillsDir, rawDir } = await import('../src/memory/scaffold.js');
  ensureDataLayout();
  if (opts.index !== undefined) fs.writeFileSync(path.join(dataDir(), 'index.md'), opts.index);
  if (opts.log !== undefined) fs.writeFileSync(path.join(dataDir(), 'log.md'), opts.log);
  if (opts.skills) {
    for (const [name, content] of Object.entries(opts.skills)) {
      fs.writeFileSync(path.join(skillsDir(), name), content);
    }
  }
  const logMtime = fs.statSync(path.join(dataDir(), 'log.md')).mtimeMs;
  for (const rel of opts.rawFiles ?? []) {
    const full = path.join(rawDir(), rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, 'x');
  }
  for (const rel of opts.oldRawFiles ?? []) {
    const full = path.join(rawDir(), rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, 'x');
    const old = (logMtime - 120_000) / 1000;
    fs.utimesSync(full, old, old);
  }
}

describe('buildBootstrapPrefix', () => {
  it('returns empty string when index, log, and skills are all empty', async () => {
    await setup({ index: '', log: '' });
    const { buildBootstrapPrefix } = await import('../src/memory/bootstrap.js');
    expect(buildBootstrapPrefix()).toBe('');
  });

  it('emits <wiki_index> and <recent_activity> blocks', async () => {
    await setup({
      index: '# Wiki index\n\n## Pages\n- foo.md — Foo Corp note',
      log: '# Activity log\n\n2026-05-25 09:00 — first turn.\n2026-05-25 10:00 — [note] foo',
    });
    const { buildBootstrapPrefix } = await import('../src/memory/bootstrap.js');
    const prefix = buildBootstrapPrefix();
    expect(prefix).toContain('<wiki_index>');
    expect(prefix).toContain('# Wiki index');
    expect(prefix).toContain('</wiki_index>');
    expect(prefix).toContain('<recent_activity>');
    expect(prefix).toContain('[note] foo');
    expect(prefix.endsWith('\n\n')).toBe(true);
  });

  it('emits <skills> from data/skills/', async () => {
    await setup({
      index: '# Wiki index\nempty',
      skills: { 'prune-wiki.md': '# Prune wiki — sweep the wiki\nrest...' },
    });
    const { buildBootstrapPrefix } = await import('../src/memory/bootstrap.js');
    const prefix = buildBootstrapPrefix();
    expect(prefix).toContain('<skills>');
    expect(prefix).toContain('skills/prune-wiki.md — Prune wiki — sweep the wiki');
  });
});

describe('buildBootstrapPrefix raw/ ingest blocks', () => {
  it('lists top-level files dropped since the last log entry in <new_sources>', async () => {
    await setup({
      index: '# Wiki index\nempty',
      log: '# Activity log\n\n2026-05-25 09:00 — turn.',
      rawFiles: ['invoice.pdf'],
    });
    const { buildBootstrapPrefix } = await import('../src/memory/bootstrap.js');
    const prefix = buildBootstrapPrefix();
    expect(prefix).toContain('<new_sources>');
    expect(prefix).toContain('raw/invoice.pdf');
  });

  it('excludes nested and old files from <new_sources>', async () => {
    await setup({
      index: '# Wiki index\nempty',
      log: '# Activity log\n\nturn.',
      rawFiles: ['receipts/nested.pdf'],   // nested → not top-level
      oldRawFiles: ['stale.pdf'],           // stamped older than log
    });
    const { buildBootstrapPrefix } = await import('../src/memory/bootstrap.js');
    const prefix = buildBootstrapPrefix();
    expect(prefix).not.toContain('raw/receipts/nested.pdf');
    expect(prefix).not.toContain('raw/stale.pdf');
  });

  it('renders existing topic folders in <raw_folders>', async () => {
    await setup({
      index: '# Wiki index\nempty',
      log: '# Activity log\n\nturn.',
      rawFiles: ['receipts/a.pdf', 'medical/b.pdf'],
    });
    const { buildBootstrapPrefix } = await import('../src/memory/bootstrap.js');
    const prefix = buildBootstrapPrefix();
    expect(prefix).toContain('<raw_folders>');
    expect(prefix).toContain('raw/receipts/');
    expect(prefix).toContain('raw/medical/');
  });
});
