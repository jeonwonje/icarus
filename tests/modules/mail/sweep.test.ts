import '../../env.js';

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { migrateDb } from '../../../src/db.js';
import { MailStore } from '../../../src/modules/mail/store.js';
import { MailSweep, type SettingsPort } from '../../../src/modules/mail/sweep.js';

/** In-memory settings so nothing here touches the real state DB. */
function memSettings(): SettingsPort {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v) };
}

function freshDrop(): string {
  return mkdtempSync(path.join(tmpdir(), 'icarus-drop-'));
}

function dropPst(dir: string, name: string, ageMs: number): string {
  const p = path.join(dir, name);
  writeFileSync(p, 'not really a pst');
  const when = new Date(Date.now() - ageMs);
  utimesSync(p, when, when);
  return p;
}

function sweepOver(dropDir: string, store: MailStore): MailSweep {
  return new MailSweep({
    store,
    filer: () => {
      throw new Error('filer should not run in discovery tests');
    },
    submit: () => {
      throw new Error('no turns expected');
    },
    notify: async () => {},
    projects: () => ['general'],
    dropDir,
    settings: memSettings(),
  });
}

/** A distinct in-memory store per test so counts() don't collide across cases. */
function isolatedStore(): MailStore {
  const mem = new DatabaseSync(':memory:');
  migrateDb(mem);
  return new MailStore(mem);
}

describe('mail discovery', () => {
  it('registers a quiet export exactly once', () => {
    const dir = freshDrop();
    const store = isolatedStore();
    try {
      dropPst(dir, 'nus.pst', 30 * 60_000);
      const sweep = sweepOver(dir, store);

      const first = sweep.discover();
      assert.equal(first.length, 1);
      assert.equal(first[0].fileName, 'nus.pst');
      assert.equal(first[0].state, 'census');

      assert.equal(sweep.discover().length, 0, 're-discovering the same file is a no-op');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips an export that is still being written', () => {
    const dir = freshDrop();
    const store = isolatedStore();
    try {
      dropPst(dir, 'inflight.pst', 5_000);
      assert.equal(sweepOver(dir, store).discover().length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('picks up a re-export of the same name once its mtime changes', () => {
    const dir = freshDrop();
    const store = isolatedStore();
    try {
      dropPst(dir, 'daily.pst', 30 * 60_000);
      const sweep = sweepOver(dir, store);
      assert.equal(sweep.discover().length, 1);

      // Same name, new content and mtime — a fresh daily export.
      const p = path.join(dir, 'daily.pst');
      writeFileSync(p, 'a different export entirely');
      const when = new Date(Date.now() - 30 * 60_000);
      utimesSync(p, when, when);

      assert.equal(sweep.discover().length, 1, 'the new export is its own row');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('survives a missing drop dir', () => {
    const store = isolatedStore();
    const gone = path.join(tmpdir(), 'icarus-drop-does-not-exist');
    assert.doesNotThrow(() => sweepOver(gone, store).discover());
  });

  it('ignores non-pst files', () => {
    const dir = freshDrop();
    const store = isolatedStore();
    try {
      const p = path.join(dir, 'notes.txt');
      writeFileSync(p, 'x');
      const when = new Date(Date.now() - 30 * 60_000);
      utimesSync(p, when, when);
      assert.equal(sweepOver(dir, store).discover().length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('mail sweep guards', () => {
  it('reports in-flight so a second fire cannot stack on the first', async () => {
    const dir = freshDrop();
    const store = isolatedStore();
    try {
      const sweep = sweepOver(dir, store);
      assert.equal(sweep.inFlight, false);
      const running = sweep.runFire();
      assert.equal(sweep.inFlight, true, 'guard is set while a fire is in progress');
      await running;
      assert.equal(sweep.inFlight, false);

      // Directly re-entering while running returns the skip marker.
      const a = sweep.runFire();
      const b = await sweep.runFire();
      await a;
      assert.match(b.status, /skipped:in-flight|ok:/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('mail sweep end to end', () => {
  it('walks census → rank → triage → filed with a stubbed pst and classifier', async () => {
    const dir = freshDrop();
    const desktop = mkdtempSync(path.join(tmpdir(), 'icarus-desktop-'));
    const store = isolatedStore();
    try {
      mkdirSync(path.join(desktop, '3_General'), { recursive: true });
      const e = store.createExport({ fileSig: 'x', fileName: 'n.pst', filePath: 'C:/n.pst', bytes: 1 });
      store.insertMessages(e.id, [
        {
          messageKey: 'k1', folderPath: '[0]', folderName: 'Inbox', childIndex: 0,
          sentAt: '2026-07-20T00:00:00.000Z', senderName: 'Prof', senderEmail: 'prof@u.edu',
          recipients: 'jeon@u.edu', subject: 'PS3 due Friday', attachmentCount: 0,
        },
        {
          messageKey: 'k2', folderPath: '[0]', folderName: 'Inbox', childIndex: 1,
          sentAt: '2026-07-20T00:00:00.000Z', senderName: 'Ads', senderEmail: 'deals@shop.com',
          recipients: 'jeon@u.edu', subject: '70% OFF TODAY', attachmentCount: 0,
        },
      ]);
      store.setExportState(e.id, 'ranking');

      const sweep = new MailSweep({
        store,
        filer: () => ({
          apply: async () => ({
            digest: '▸ due · PS3 — Friday',
            filed: [],
            links: [],
            deadlines: [],
            questions: [],
            alerts: [],
          }),
        }) as never,
        submit: (job) => {
          job.onDone?.({ status: 'ok', finalText: '{"digest":"▸ due · PS3 — Friday"}' });
        },
        notify: async () => {},
        projects: () => ['general'],
        dropDir: dir,
        settings: memSettings(),
        classifier: async (prompt) => {
          if (!prompt.includes('screening a mailbox by correspondent')) {
            return JSON.stringify({ ranks: [] });
          }
          // ids are positional — mirror the order the prompt listed the senders in.
          const listed = [...prompt.matchAll(/#\d+ \| .*?<([^>]+)>/g)].map((m) => m[1]);
          return JSON.stringify({
            senders: listed.map((email, i) => ({
              id: i + 1,
              verdict: email === 'deals@shop.com' ? 'noise' : 'relevant',
              why: email === 'deals@shop.com' ? 'marketing' : 'coursework',
            })),
          });
        },
        openPst: () => ({ getRootFolder: () => ({}), close: () => {} }) as never,
      });

      const res = await sweep.runFire();

      assert.equal(store.countByState(e.id, 'skipped'), 1, 'the ad sender was settled wholesale');
      assert.equal(store.getExport(e.id)!.state, 'done');
      assert.match(res.status, /^ok:/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(desktop, { recursive: true, force: true });
    }
  });
});
