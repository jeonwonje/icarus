import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const realCwd = process.cwd();
let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-scaffold-'));
  process.chdir(tmpRoot);
  // Default RAW_DIR points at the real Windows Desktop, whose parent exists on
  // dev hosts — that would make tests symlink data/raw to it. Pin RAW_DIR into
  // the tmp tree so the suite never touches the real Desktop. Tests that
  // exercise specific symlink/fallback branches override this themselves.
  process.env.RAW_DIR = path.join(tmpRoot, 'raw-store');
  vi.resetModules();
});
afterEach(() => {
  process.chdir(realCwd);
  delete process.env.RAW_DIR;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('ensureDataLayout', () => {
  it('creates wiki/, outbox/, skills/ and seeds index.md + log.md on first run', async () => {
    const { ensureDataLayout, dataDir, skillsDir } = await import(
      '../src/memory/scaffold.js'
    );
    const created = ensureDataLayout();
    expect(created).toBe(true);
    expect(fs.statSync(path.join(dataDir(), 'wiki')).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(dataDir(), 'outbox')).isDirectory()).toBe(true);
    expect(fs.statSync(skillsDir()).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(dataDir(), 'index.md'), 'utf-8')).toContain('# Wiki index');
    expect(fs.readFileSync(path.join(dataDir(), 'log.md'), 'utf-8')).toContain('# Activity log');
    // CLAUDE.md ships in git, not generated.
    expect(fs.existsSync(path.join(dataDir(), 'CLAUDE.md'))).toBe(false);
  });

  it('does not create the legacy threads/ folder', async () => {
    const { ensureDataLayout, dataDir } = await import('../src/memory/scaffold.js');
    ensureDataLayout();
    expect(fs.existsSync(path.join(dataDir(), 'threads'))).toBe(false);
  });

  it('preserves existing index.md and log.md (idempotent)', async () => {
    const { ensureDataLayout, dataDir } = await import('../src/memory/scaffold.js');
    ensureDataLayout();
    fs.writeFileSync(path.join(dataDir(), 'index.md'), '# customised\n');
    const created = ensureDataLayout();
    expect(created).toBe(false);
    expect(fs.readFileSync(path.join(dataDir(), 'index.md'), 'utf-8')).toBe('# customised\n');
  });

  it('symlinks data/raw to RAW_DIR when its parent exists', async () => {
    const desktop = path.join(tmpRoot, 'desktop');
    fs.mkdirSync(desktop, { recursive: true });
    process.env.RAW_DIR = path.join(desktop, 'icarus-raw');
    const { ensureDataLayout, rawDir } = await import('../src/memory/scaffold.js');
    ensureDataLayout();
    const link = rawDir();
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(link)).toBe(fs.realpathSync(process.env.RAW_DIR));
    delete process.env.RAW_DIR;
  });

  it('falls back to a real local data/raw when the RAW_DIR parent is missing', async () => {
    process.env.RAW_DIR = path.join(tmpRoot, 'no-such-mount', 'deep', 'icarus-raw');
    const { ensureDataLayout, rawDir } = await import('../src/memory/scaffold.js');
    ensureDataLayout();
    const link = rawDir();
    const st = fs.lstatSync(link);
    expect(st.isSymbolicLink()).toBe(false);
    expect(st.isDirectory()).toBe(true);
    delete process.env.RAW_DIR;
  });
});
