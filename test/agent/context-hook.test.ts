import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('buildTurnContext', () => {
  let dir: string;
  let cwd: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-ctx-'));
    cwd = process.cwd();
    process.chdir(dir);
    vi.resetModules();
  });
  afterEach(() => {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
    vi.resetModules();
  });

  it('flags loose files at raw/ root but not files inside raw/canvas or raw/outlook', async () => {
    const { ensureHubLayout, rawDir, rawCanvasDir } = await import('../../src/memory/scaffold.js');
    ensureHubLayout();
    fs.writeFileSync(path.join(rawDir(), 'loose.pdf'), 'x');
    fs.writeFileSync(path.join(rawCanvasDir(), 'lecture.pdf'), 'x');

    const { buildTurnContext } = await import('../../src/agent/context-hook.js');
    const ctx = buildTurnContext('personal');
    expect(ctx).toContain('raw/loose.pdf');
    expect(ctx).not.toContain('lecture.pdf');
    expect(ctx).toContain('<outbox>');
  });
});
