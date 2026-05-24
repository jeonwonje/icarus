import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const realCwd = process.cwd();
let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-bootstrap-'));
  process.chdir(tmpRoot);
  vi.resetModules();
});
afterEach(() => {
  process.chdir(realCwd);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

async function setup(opts: { index?: string; log?: string; skills?: Record<string, string> }) {
  const { ensureDataLayout, dataDir, skillsDir } = await import('../src/memory/scaffold.js');
  ensureDataLayout();
  if (opts.index !== undefined) fs.writeFileSync(path.join(dataDir(), 'index.md'), opts.index);
  if (opts.log !== undefined) fs.writeFileSync(path.join(dataDir(), 'log.md'), opts.log);
  if (opts.skills) {
    for (const [name, content] of Object.entries(opts.skills)) {
      fs.writeFileSync(path.join(skillsDir(), name), content);
    }
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
