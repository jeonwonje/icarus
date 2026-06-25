import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('grounding contract in scaffolded hub', () => {
  let dir: string;
  let cwd: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-ground-'));
    cwd = process.cwd();
    process.chdir(dir);
    fs.mkdirSync(path.join(dir, 'skills'), { recursive: true });
    vi.resetModules();
  });
  afterEach(() => {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
    vi.resetModules();
  });

  it('CLAUDE.md states the no-hallucination + cite-source rule', async () => {
    const { ensureHubLayout, hubDir } = await import('../../src/memory/scaffold.js');
    ensureHubLayout();
    const claudeMd = fs.readFileSync(path.join(hubDir(), 'CLAUDE.md'), 'utf-8');
    expect(claudeMd.toLowerCase()).toContain('no hallucination');
    expect(claudeMd.toLowerCase()).toContain('cite');
    expect(claudeMd).toContain('raw/');
  });
});
