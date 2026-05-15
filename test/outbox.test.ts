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

const JID = 'tg:-100:53';

async function loadOutbox() {
  return import('../src/memory/outbox.js');
}

function threadOutbox(): string {
  return path.join(tmpRoot, 'data', 'threads', '53', 'outbox');
}

describe('outbox (per-thread)', () => {
  it('returns empty when this thread has no outbox dir', async () => {
    const { listOutbox } = await loadOutbox();
    expect(listOutbox(JID)).toEqual([]);
  });

  it('lists files, pairs with .caption siblings, classifies image vs document', async () => {
    const out = threadOutbox();
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'report.pdf'), 'pdf-bytes');
    fs.writeFileSync(path.join(out, 'report.pdf.caption'), 'Q1 roll-up');
    fs.writeFileSync(path.join(out, 'chart.png'), 'png-bytes');

    const { listOutbox } = await loadOutbox();
    const files = listOutbox(JID).sort((a, b) => a.filename.localeCompare(b.filename));
    expect(files).toHaveLength(2);
    const chart = files.find((f) => f.filename === 'chart.png')!;
    const report = files.find((f) => f.filename === 'report.pdf')!;
    expect(chart.fileType).toBe('image');
    expect(chart.caption).toBeUndefined();
    expect(report.fileType).toBe('document');
    expect(report.caption).toBe('Q1 roll-up');
  });

  it('removeOutboxFile deletes both the file and its caption sibling', async () => {
    const out = threadOutbox();
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'x.pdf'), 'x');
    fs.writeFileSync(path.join(out, 'x.pdf.caption'), 'cap');

    const { listOutbox, removeOutboxFile } = await loadOutbox();
    const [file] = listOutbox(JID);
    removeOutboxFile(file);
    expect(fs.existsSync(path.join(out, 'x.pdf'))).toBe(false);
    expect(fs.existsSync(path.join(out, 'x.pdf.caption'))).toBe(false);
  });

  it('does not leak files from another thread', async () => {
    const otherOutbox = path.join(tmpRoot, 'data', 'threads', '99', 'outbox');
    fs.mkdirSync(otherOutbox, { recursive: true });
    fs.writeFileSync(path.join(otherOutbox, 'secret.pdf'), 'secret');

    const { listOutbox } = await loadOutbox();
    expect(listOutbox(JID)).toEqual([]);
    expect(listOutbox('tg:-100:99').map((f) => f.filename)).toEqual(['secret.pdf']);
  });
});
