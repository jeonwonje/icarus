import '../../env.js';

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { migrateDb } from '../../../src/db.js';
import { RawShelfStore } from '../../../src/rawShelfStore.js';
import { MailFiler } from '../../../src/modules/mail/filer.js';
import { MailStore, type MailMessageRow } from '../../../src/modules/mail/store.js';
import { MailTriageSchema } from '../../../src/modules/mail/triageOutput.js';

function harness() {
  const db = new DatabaseSync(':memory:');
  migrateDb(db);
  let n = 0;
  const store = new MailStore(db, () => `2026-07-26T00:00:${String(n++).padStart(2, '0')}.000Z`);
  const desktop = mkdtempSync(path.join(tmpdir(), 'icarus-desktop-'));
  mkdirSync(path.join(desktop, '1_Projects', 'morianlabs'), { recursive: true });
  mkdirSync(path.join(desktop, '3_General'), { recursive: true });

  const attDir = mkdtempSync(path.join(tmpdir(), 'icarus-att-'));
  writeFileSync(path.join(attDir, 'ps3.pdf'), 'real attachment');

  const e = store.createExport({ fileSig: 's', fileName: 'a.pst', filePath: 'C:/a.pst', bytes: 1 });
  store.insertMessages(e.id, [
    {
      messageKey: 'k1',
      folderPath: '[0]',
      folderName: 'Inbox',
      childIndex: 0,
      sentAt: '2026-07-20T00:00:00.000Z',
      senderName: 'Prof',
      senderEmail: 'p@u.edu',
      recipients: 'jeon@u.edu',
      subject: 'PS3',
      attachmentCount: 1,
    },
  ]);
  const row = store.getMessage(1)!;
  store.setMaterialized(row.id, path.join(attDir, 'msg.md'), attDir);

  const filer = new MailFiler({
    store,
    shelf: new RawShelfStore(db),
    projects: () => ['morianlabs', 'academic', 'general'],
    desktopDir: desktop,
  });

  const fresh = (): MailMessageRow => store.getMessage(row.id)!;
  const cleanup = () => {
    rmSync(desktop, { recursive: true, force: true });
    rmSync(attDir, { recursive: true, force: true });
  };
  return { store, filer, desktop, attDir, fresh, cleanup };
}

const out = (over: Record<string, unknown>) => MailTriageSchema.parse({ digest: 'ok', ...over });

describe('MailFiler', () => {
  it('files an attachment into a project raw dir and records the audit row', async () => {
    const h = harness();
    try {
      const row = h.fresh();
      const res = await h.filer.apply(
        [row],
        out({ file: [{ id: row.id, attachment: 'ps3.pdf', project: 'morianlabs', why: 'coursework' }] }),
      );

      assert.equal(res.filed.length, 1);
      assert.equal(res.alerts.length, 0);
      assert.equal(res.filed[0].project, 'morianlabs');

      const rawDir = path.join(h.desktop, '1_Projects', 'morianlabs', 'raw');
      const landed = readdirSync(rawDir);
      assert.equal(landed.length, 1);
      assert.match(landed[0], /ps3\.pdf$/);

      const audit = h.store.listFiled(10, 0);
      assert.equal(audit.length, 1);
      assert.equal(audit[0].project, 'morianlabs');
      assert.equal(audit[0].kind, 'attachment');
    } finally {
      h.cleanup();
    }
  });

  it('asks instead of writing when the slug is unknown', async () => {
    const h = harness();
    try {
      const row = h.fresh();
      const res = await h.filer.apply(
        [row],
        out({ file: [{ id: row.id, attachment: 'ps3.pdf', project: 'cs2109s', why: 'x' }] }),
      );
      assert.equal(res.filed.length, 0);
      assert.equal(res.questions.length, 1);
      assert.match(res.questions[0], /no project called "cs2109s"/);
      assert.equal(h.store.listFiled(10, 0).length, 0);
    } finally {
      h.cleanup();
    }
  });

  it('refuses an attachment path that escapes the message directory', async () => {
    const h = harness();
    try {
      const row = h.fresh();
      const res = await h.filer.apply(
        [row],
        out({ file: [{ id: row.id, attachment: '../../../secrets.txt', project: 'general', why: 'x' }] }),
      );
      assert.equal(res.filed.length, 0);
      assert.match(res.alerts[0], /escapes the message directory/);
    } finally {
      h.cleanup();
    }
  });

  it('refuses a document that already lives inside the data root', async () => {
    const h = harness();
    try {
      const inside = path.join(h.desktop, '3_General', 'already-filed.pdf');
      writeFileSync(inside, 'x');
      const row = h.fresh();
      const res = await h.filer.apply(
        [row],
        out({ documents: [{ id: row.id, path: inside, displayName: 'already-filed.pdf', project: 'general', why: 'x' }] }),
      );
      assert.equal(res.filed.length, 0);
      assert.match(res.alerts[0], /inside the data root/);
    } finally {
      h.cleanup();
    }
  });

  it('files a produced document from the temp dir', async () => {
    const h = harness();
    const scratch = mkdtempSync(path.join(tmpdir(), 'icarus-doc-'));
    try {
      const doc = path.join(scratch, 'syllabus.pdf');
      writeFileSync(doc, 'downloaded bytes');
      const row = h.fresh();
      const res = await h.filer.apply(
        [row],
        out({ documents: [{ id: row.id, path: doc, displayName: 'syllabus.pdf', project: 'general', why: 'from a link' }] }),
      );
      assert.equal(res.filed.length, 1);
      assert.equal(h.store.listFiled(10, 0)[0].kind, 'document');
      assert.match(readdirSync(path.join(h.desktop, '3_General')).join(), /syllabus\.pdf/);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
      h.cleanup();
    }
  });

  it('one bad entry does not lose the good ones or the digest', async () => {
    const h = harness();
    try {
      const row = h.fresh();
      const res = await h.filer.apply(
        [row],
        out({
          file: [
            { id: row.id, attachment: 'nope.pdf', project: 'general', why: 'x' },
            { id: row.id, attachment: 'ps3.pdf', project: 'general', why: 'y' },
          ],
        }),
      );
      assert.equal(res.filed.length, 1);
      assert.equal(res.alerts.length, 1);
      assert.equal(res.digest, 'ok');
    } finally {
      h.cleanup();
    }
  });

  it('records links without filing them, defaulting an unknown slug to general', async () => {
    const h = harness();
    try {
      const row = h.fresh();
      const res = await h.filer.apply(
        [row],
        out({ links: [{ id: row.id, url: 'https://nus.edu/timetable', title: 'Timetable', project: 'bogus', why: 'portal' }] }),
      );
      assert.equal(res.links.length, 1);
      assert.equal(res.links[0].project, 'general');
      assert.equal(res.filed.length, 0);
      assert.equal(h.store.listLinks(10, 0).length, 1);
    } finally {
      h.cleanup();
    }
  });

  it('stops at the per-fire filing budget and says so', async () => {
    const db = new DatabaseSync(':memory:');
    migrateDb(db);
    const store = new MailStore(db);
    const desktop = mkdtempSync(path.join(tmpdir(), 'icarus-desktop-'));
    mkdirSync(path.join(desktop, '3_General'), { recursive: true });
    const attDir = mkdtempSync(path.join(tmpdir(), 'icarus-att-'));
    writeFileSync(path.join(attDir, 'a.pdf'), 'a');
    writeFileSync(path.join(attDir, 'b.pdf'), 'b');

    const e = store.createExport({ fileSig: 's', fileName: 'a.pst', filePath: 'C:/a.pst', bytes: 1 });
    store.insertMessages(e.id, [
      {
        messageKey: 'k1', folderPath: '[0]', folderName: 'Inbox', childIndex: 0,
        sentAt: null, senderName: '', senderEmail: 'p@u.edu', recipients: '',
        subject: 'S', attachmentCount: 2,
      },
    ]);
    const row = store.getMessage(1)!;
    store.setMaterialized(row.id, path.join(attDir, 'm.md'), attDir);

    const filer = new MailFiler({
      store,
      shelf: new RawShelfStore(db),
      projects: () => ['general'],
      desktopDir: desktop,
      budget: 1,
    });
    try {
      const res = await filer.apply(
        [store.getMessage(row.id)!],
        out({
          file: [
            { id: row.id, attachment: 'a.pdf', project: 'general', why: 'x' },
            { id: row.id, attachment: 'b.pdf', project: 'general', why: 'y' },
          ],
        }),
      );
      assert.equal(res.filed.length, 1);
      assert.match(res.alerts.join(), /filing budget/);
    } finally {
      rmSync(desktop, { recursive: true, force: true });
      rmSync(attDir, { recursive: true, force: true });
    }
  });
});
