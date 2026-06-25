import { describe, expect, it } from 'vitest';
import {
  canvasCourseAllowed,
  outlookFolderAllowed,
  outlookSenderAllowed,
  type SourcesConfig,
} from '../../src/config/sources.js';

const cfg: SourcesConfig = {
  canvas: { courses: ['101', '202'], modules: [] },
  outlook: { senderAllow: ['boss@uni.edu'], folderAllow: [], folderBlock: ['Junk Email'] },
};

describe('sources allowlist', () => {
  it('canvas: allowlist restricts; empty allows all', () => {
    expect(canvasCourseAllowed(cfg, '101')).toBe(true);
    expect(canvasCourseAllowed(cfg, '999')).toBe(false);
    expect(canvasCourseAllowed({ ...cfg, canvas: { courses: [], modules: [] } }, '999')).toBe(true);
  });

  it('outlook: folderBlock always wins, even with empty allow', () => {
    expect(outlookFolderAllowed(cfg, 'Inbox')).toBe(true);
    expect(outlookFolderAllowed(cfg, 'Junk Email')).toBe(false);
  });

  it('outlook: senderAllow restricts when non-empty', () => {
    expect(outlookSenderAllowed(cfg, 'boss@uni.edu')).toBe(true);
    expect(outlookSenderAllowed(cfg, 'spam@x.com')).toBe(false);
  });
});
