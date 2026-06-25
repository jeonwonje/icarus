import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('ensureHubLayout', () => {
  let dir: string;
  let cwd: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-hub-'));
    cwd = process.cwd();
    process.chdir(dir);
    // a repo skills/ dir to be copied into the hub
    fs.mkdirSync(path.join(dir, 'skills', 'canvas-ingest'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'skills', 'canvas-ingest', 'SKILL.md'), '# canvas');
    vi.resetModules();
  });
  afterEach(() => {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
    vi.resetModules();
  });

  it('creates the hub skeleton and copies skills', async () => {
    const { ensureHubLayout, hubDir } = await import('../../src/memory/scaffold.js');
    const created = ensureHubLayout();
    expect(created).toBe(true);
    const hub = hubDir();
    for (const rel of [
      'raw/canvas',
      'raw/outlook',
      'wiki',
      'index.md',
      'log.md',
      'CLAUDE.md',
      '.claude/settings.json',
      '.claude/skills/canvas-ingest/SKILL.md',
    ]) {
      expect(fs.existsSync(path.join(hub, rel)), rel).toBe(true);
    }
  });

  it('is idempotent: second run does not clobber edited CLAUDE.md', async () => {
    const { ensureHubLayout, hubDir } = await import('../../src/memory/scaffold.js');
    ensureHubLayout();
    const claudeMd = path.join(hubDir(), 'CLAUDE.md');
    fs.writeFileSync(claudeMd, 'EDITED');
    ensureHubLayout();
    expect(fs.readFileSync(claudeMd, 'utf-8')).toBe('EDITED');
  });
});
