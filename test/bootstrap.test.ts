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

const JID = 'tg:-100:53';

async function setupThread(opts: { index?: string; log?: string; skills?: Record<string, string> }) {
  const { ensureDataLayout, skillsDir } = await import('../src/memory/scaffold.js');
  const { ensureThreadLayout, threadIndexFile, threadLogFile } = await import(
    '../src/memory/threads.js'
  );
  ensureDataLayout();
  ensureThreadLayout(JID);
  if (opts.index !== undefined) fs.writeFileSync(threadIndexFile(JID), opts.index);
  if (opts.log !== undefined) fs.writeFileSync(threadLogFile(JID), opts.log);
  if (opts.skills) {
    for (const [name, content] of Object.entries(opts.skills)) {
      fs.writeFileSync(path.join(skillsDir(), name), content);
    }
  }
}

describe('buildBootstrapPrefix', () => {
  it('returns empty string when the thread has no notable artifacts and no skills', async () => {
    await setupThread({ index: '', log: '' });
    const { buildBootstrapPrefix } = await import('../src/memory/bootstrap.js');
    expect(buildBootstrapPrefix(JID)).toBe('');
  });

  it('emits <wiki_index> and <recent_activity> for the current thread', async () => {
    await setupThread({
      index: '# Wiki index\n\n## Pages\n- foo.md — Foo Corp note',
      log: '# Activity log\n\n2026-04-21 09:00 — initial note.\n2026-04-21 10:00 — [note] foo',
    });
    const { buildBootstrapPrefix } = await import('../src/memory/bootstrap.js');
    const prefix = buildBootstrapPrefix(JID);
    expect(prefix).toContain('<wiki_index>');
    expect(prefix).toContain('# Wiki index');
    expect(prefix).toContain('</wiki_index>');
    expect(prefix).toContain('<recent_activity>');
    expect(prefix).toContain('[note] foo');
    expect(prefix.endsWith('\n\n')).toBe(true);
  });

  it('emits <skills> from the global data/skills/ folder', async () => {
    await setupThread({
      index: '# Wiki index\nempty',
      skills: {
        'prune-wiki.md': '# Prune wiki — sweep this topic\nrest...',
      },
    });
    const { buildBootstrapPrefix } = await import('../src/memory/bootstrap.js');
    const prefix = buildBootstrapPrefix(JID);
    expect(prefix).toContain('<skills>');
    expect(prefix).toContain('skills/prune-wiki.md — Prune wiki — sweep this topic');
  });

  it('does not leak content from another thread', async () => {
    await setupThread({ index: '# Thread 53\nfoo' });
    // Create a second thread with different content
    const { ensureThreadLayout, threadIndexFile } = await import('../src/memory/threads.js');
    ensureThreadLayout('tg:-100:99');
    fs.writeFileSync(threadIndexFile('tg:-100:99'), '# Thread 99 SECRET\nbar');

    const { buildBootstrapPrefix } = await import('../src/memory/bootstrap.js');
    const prefix = buildBootstrapPrefix(JID);
    expect(prefix).toContain('Thread 53');
    expect(prefix).not.toContain('Thread 99');
    expect(prefix).not.toContain('SECRET');
  });
});
