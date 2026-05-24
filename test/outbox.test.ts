import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const realCwd = process.cwd();
let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-outbox-'));
  process.chdir(tmpRoot);
  vi.resetModules();
});
afterEach(() => {
  process.chdir(realCwd);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function outboxDir(): string {
  return path.join(tmpRoot, 'data', 'outbox');
}

describe('outbox', () => {
  it('returns empty when no outbox dir exists', async () => {
    const { listOutbox } = await import('../src/memory/outbox.js');
    expect(listOutbox()).toEqual([]);
  });

  it('lists files, pairs with .caption siblings, classifies image vs document', async () => {
    fs.mkdirSync(outboxDir(), { recursive: true });
    fs.writeFileSync(path.join(outboxDir(), 'report.pdf'), 'pdf-bytes');
    fs.writeFileSync(path.join(outboxDir(), 'report.pdf.caption'), 'Q1 roll-up');
    fs.writeFileSync(path.join(outboxDir(), 'chart.png'), 'png-bytes');

    const { listOutbox } = await import('../src/memory/outbox.js');
    const files = listOutbox().sort((a, b) => a.filename.localeCompare(b.filename));
    expect(files).toHaveLength(2);
    const chart = files.find((f) => f.filename === 'chart.png')!;
    const report = files.find((f) => f.filename === 'report.pdf')!;
    expect(chart.fileType).toBe('image');
    expect(chart.caption).toBeUndefined();
    expect(report.fileType).toBe('document');
    expect(report.caption).toBe('Q1 roll-up');
  });

  it('removeOutboxFile deletes both file and caption sibling', async () => {
    fs.mkdirSync(outboxDir(), { recursive: true });
    fs.writeFileSync(path.join(outboxDir(), 'x.pdf'), 'x');
    fs.writeFileSync(path.join(outboxDir(), 'x.pdf.caption'), 'cap');

    const { listOutbox, removeOutboxFile } = await import('../src/memory/outbox.js');
    const [file] = listOutbox();
    removeOutboxFile(file);
    expect(fs.existsSync(path.join(outboxDir(), 'x.pdf'))).toBe(false);
    expect(fs.existsSync(path.join(outboxDir(), 'x.pdf.caption'))).toBe(false);
  });
});
