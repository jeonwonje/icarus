import { describe, expect, it } from 'vitest';

import {
  buildContentWithFileNotes,
  detectOversizedAttachment,
  type DownloadedFile,
} from '../src/telegram.js';

const TWENTY_MB = 20 * 1024 * 1024;

describe('detectOversizedAttachment', () => {
  it('flags a document larger than the download cap', () => {
    const msg = { message_id: 1, document: { file_name: 'big.zip', file_size: TWENTY_MB + 1 } };
    expect(detectOversizedAttachment(msg)).toEqual({ name: 'big.zip', sizeBytes: TWENTY_MB + 1 });
  });

  it('returns null for a document under the cap', () => {
    const msg = { message_id: 1, document: { file_name: 'ok.pdf', file_size: 1024 } };
    expect(detectOversizedAttachment(msg)).toBeNull();
  });

  it('ignores photos (Telegram rescales them under the cap)', () => {
    const msg = { message_id: 1, photo: [{ file_id: 'p', file_size: TWENTY_MB + 1 }] };
    expect(detectOversizedAttachment(msg)).toBeNull();
  });

  it('returns null when there is no attachment', () => {
    expect(detectOversizedAttachment({ message_id: 1, text: 'hi' })).toBeNull();
  });
});

describe('buildContentWithFileNotes', () => {
  const files: DownloadedFile[] = [
    { localPath: '/data/raw/a.pdf', originalName: 'a.pdf', kind: 'document', sizeBytes: 10 },
  ];

  it('returns plain text when no files', () => {
    expect(buildContentWithFileNotes('hello', [])).toBe('hello');
  });

  it('prepends a saved-to note and keeps the caption', () => {
    const out = buildContentWithFileNotes('my invoice', files);
    expect(out).toContain('[document: a.pdf] saved to raw/a.pdf');
    expect(out).toContain('my invoice');
  });

  it('emits just the note when there is no text', () => {
    expect(buildContentWithFileNotes('', files)).toBe('[document: a.pdf] saved to raw/a.pdf');
  });
});
