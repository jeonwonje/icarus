import '../../env.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  enumerateFolders,
  folderAt,
  isFileableAttachment,
  isOutboundFolder,
  parseCursor,
} from '../../../src/modules/mail/census.js';
import type { PSTFolder } from 'pst-extractor';

/** Minimal stand-in for the pst-extractor folder tree. */
function folder(name: string, contentCount: number, subs: unknown[] = []): PSTFolder {
  return {
    displayName: name,
    contentCount,
    get hasSubfolders() {
      return subs.length > 0;
    },
    getSubFolders: () => subs,
  } as unknown as PSTFolder;
}

describe('scan cursor', () => {
  it('round-trips and rejects junk', () => {
    assert.deepEqual(parseCursor('{"queue":[[0],[1]],"current":[0],"childIndex":4}'), {
      queue: [[0], [1]],
      current: [0],
      childIndex: 4,
    });
    assert.equal(parseCursor(null), null);
    assert.equal(parseCursor('not json'), null);
    assert.equal(parseCursor('{"nope":1}'), null, 'a cursor without a queue is unusable');
    assert.deepEqual(parseCursor('{"queue":[]}'), { queue: [], current: null, childIndex: 0 });
  });
});

describe('folder walking', () => {
  it('resolves an index path and returns null when it no longer fits', () => {
    const leaf = folder('Sub', 3);
    const root = folder('Root', 0, [folder('Inbox', 5), folder('Archive', 0, [leaf])]);

    assert.equal(folderAt(root, [])!.displayName, 'Root');
    assert.equal(folderAt(root, [0])!.displayName, 'Inbox');
    assert.equal(folderAt(root, [1, 0])!.displayName, 'Sub');
    assert.equal(folderAt(root, [9]), null);
    assert.equal(folderAt(root, [0, 0]), null);
  });

  it('queues only folders holding messages and totals their counts', () => {
    const root = folder('Root', 0, [
      folder('Inbox', 5),
      folder('Empty', 0),
      folder('Archive', 2, [folder('2025', 7)]),
    ]);
    const { queue, total } = enumerateFolders(root);

    assert.equal(total, 14);
    assert.deepEqual(queue, [[0], [2], [2, 0]], 'empty folders are not queued');
  });

  it('skips outbound folders but keeps Junk for the ranker to judge', () => {
    assert.equal(isOutboundFolder('Sent Items'), true);
    assert.equal(isOutboundFolder('  drafts '), true);
    assert.equal(isOutboundFolder('Outbox'), true);
    assert.equal(isOutboundFolder('Junk Email'), false, 'what counts as junk is a relevance call');
    assert.equal(isOutboundFolder('Inbox'), false);

    const root = folder('Root', 0, [
      folder('Inbox', 10),
      folder('Sent Items', 174),
      folder('Junk Email', 1),
    ]);
    const { queue, total } = enumerateFolders(root);
    assert.deepEqual(queue, [[0], [2]], 'Sent Items never enters the work queue');
    assert.equal(total, 11, 'and its 174 messages are not counted as work');
  });

  it('abandons a branch whose subfolder listing throws', () => {
    const bad = {
      displayName: 'Bad',
      contentCount: 1,
      get hasSubfolders() {
        return true;
      },
      getSubFolders: () => {
        throw new Error('corrupt');
      },
    } as unknown as PSTFolder;
    const root = folder('Root', 0, [folder('Good', 2), bad]);

    const { queue, total } = enumerateFolders(root);
    assert.deepEqual(queue, [[0], [1]]);
    assert.equal(total, 3, 'the bad branch still contributes its own count, just no children');
  });
});

describe('attachment eligibility', () => {
  const att = (over: Partial<Parameters<typeof isFileableAttachment>[0]> = {}) => ({
    contentId: '',
    isAttachmentInvisibleInHtml: false,
    filesize: 500_000,
    longFilename: 'syllabus.pdf',
    filename: 'syllabus.pdf',
    ...over,
  });

  it('keeps real documents', () => {
    assert.equal(isFileableAttachment(att()), true);
    assert.equal(isFileableAttachment(att({ longFilename: 'photo.jpg', filesize: 2_000_000 })), true);
  });

  it('drops inline HTML furniture', () => {
    assert.equal(isFileableAttachment(att({ contentId: 'logo123' })), false, 'inline asset');
    assert.equal(isFileableAttachment(att({ isAttachmentInvisibleInHtml: true })), false);
    assert.equal(
      isFileableAttachment(att({ longFilename: 'image001.png', filesize: 4_000 })),
      false,
      'tiny image — the newsletter-logo case',
    );
  });
});
