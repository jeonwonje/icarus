import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const realCwd = process.cwd();
let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-scaffold-'));
  process.chdir(tmpRoot);
  vi.resetModules();
});
afterEach(() => {
  process.chdir(realCwd);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('ensureDataLayout', () => {
  it('creates threads/ and skills/ on first run', async () => {
    const { ensureDataLayout, dataDir, skillsDir, threadsRoot } = await import(
      '../src/memory/scaffold.js'
    );
    const created = ensureDataLayout();
    expect(created).toBe(true);
    expect(fs.statSync(threadsRoot()).isDirectory()).toBe(true);
    expect(fs.statSync(skillsDir()).isDirectory()).toBe(true);
    // Sanity check: no embedded CLAUDE.md template — that ships in git.
    expect(fs.existsSync(path.join(dataDir(), 'CLAUDE.md'))).toBe(false);
  });

  it('is idempotent', async () => {
    const { ensureDataLayout } = await import('../src/memory/scaffold.js');
    ensureDataLayout();
    expect(ensureDataLayout()).toBe(false);
  });
});

describe('ensureThreadLayout', () => {
  it('creates wiki/, index.md, log.md under data/threads/<id>/', async () => {
    const { ensureDataLayout } = await import('../src/memory/scaffold.js');
    const { ensureThreadLayout, threadDir, threadWikiDir, threadIndexFile, threadLogFile } =
      await import('../src/memory/threads.js');
    ensureDataLayout();
    const jid = 'tg:-100:53';
    const created = ensureThreadLayout(jid);
    expect(created).toBe(true);
    expect(threadDir(jid)).toBe(path.join(tmpRoot, 'data', 'threads', '53'));
    expect(fs.statSync(threadWikiDir(jid)).isDirectory()).toBe(true);
    expect(fs.readFileSync(threadIndexFile(jid), 'utf-8')).toContain('# Wiki index');
    expect(fs.readFileSync(threadLogFile(jid), 'utf-8')).toContain('thread folder created');
  });

  it('preserves existing files (idempotent)', async () => {
    const { ensureDataLayout } = await import('../src/memory/scaffold.js');
    const { ensureThreadLayout, threadIndexFile } = await import('../src/memory/threads.js');
    ensureDataLayout();
    const jid = 'tg:-100:53';
    ensureThreadLayout(jid);
    fs.writeFileSync(threadIndexFile(jid), '# customised\n');
    const created = ensureThreadLayout(jid);
    expect(created).toBe(false);
    expect(fs.readFileSync(threadIndexFile(jid), 'utf-8')).toBe('# customised\n');
  });

  it('falls back to a sanitized name for synthetic CLI JIDs', async () => {
    const { ensureDataLayout } = await import('../src/memory/scaffold.js');
    const { threadDir } = await import('../src/memory/threads.js');
    ensureDataLayout();
    expect(threadDir('cli:weekly-prune')).toBe(
      path.join(tmpRoot, 'data', 'threads', '_cli_weekly-prune'),
    );
  });
});
