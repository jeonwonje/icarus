import { describe, expect, it } from 'vitest';
import {
  canvasCourseAllowed,
  outlookFolderAllowed,
  outlookSenderAllowed,
  outlookAttachmentAllowed,
  classifyOutlookSender,
  outlookBlockReason,
  type SourcesConfig,
} from '../../src/config/sources.js';

const cfg: SourcesConfig = {
  canvas: { courses: ['101', '202'], modules: [] },
  outlook: {
    senderAllow: ['boss@uni.edu'],
    folderAllow: [],
    folderBlock: ['Junk Email'],
    attachmentKeepExt: ['pdf', 'docx', 'zip'],
    attachmentMinImageKB: 50,
    dropInlineImages: true,
  },
};

const attCfg: SourcesConfig = {
  canvas: { courses: [], modules: [] },
  outlook: {
    senderAllow: [],
    folderAllow: [],
    folderBlock: ['Junk Email'],
    attachmentKeepExt: ['pdf', 'docx', 'zip'],
    attachmentMinImageKB: 50,
    dropInlineImages: true,
  },
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

describe('outlookAttachmentAllowed', () => {
  it('keeps allow-list document extensions regardless of contentId', () => {
    expect(outlookAttachmentAllowed(attCfg, { ext: 'pdf', contentId: '', mimeTag: '', sizeBytes: 1000 })).toBe(true);
    expect(outlookAttachmentAllowed(attCfg, { ext: 'pdf', contentId: 'abc@x', mimeTag: '', sizeBytes: 1000 })).toBe(true);
  });

  it('drops inline (contentId) images when dropInlineImages is true', () => {
    expect(outlookAttachmentAllowed(attCfg, { ext: 'png', contentId: 'cid1', mimeTag: 'image/png', sizeBytes: 999999 })).toBe(false);
  });

  it('keeps standalone images above the size threshold', () => {
    expect(outlookAttachmentAllowed(attCfg, { ext: 'jpg', contentId: '', mimeTag: '', sizeBytes: 200 * 1024 })).toBe(true);
  });

  it('drops standalone images at or below the size threshold', () => {
    expect(outlookAttachmentAllowed(attCfg, { ext: 'png', contentId: '', mimeTag: '', sizeBytes: 10 * 1024 })).toBe(false);
  });

  it('detects images by mimeTag when ext is missing', () => {
    expect(outlookAttachmentAllowed(attCfg, { ext: '', contentId: '', mimeTag: 'image/jpeg', sizeBytes: 200 * 1024 })).toBe(true);
  });

  it('drops non-document, non-image noise (p7m, mso, none)', () => {
    expect(outlookAttachmentAllowed(attCfg, { ext: 'p7m', contentId: '', mimeTag: '', sizeBytes: 5000 })).toBe(false);
    expect(outlookAttachmentAllowed(attCfg, { ext: '', contentId: '', mimeTag: '', sizeBytes: 5000 })).toBe(false);
  });
});

const clsCfg: SourcesConfig = {
  canvas: { courses: [], modules: [] },
  outlook: {
    senderAllow: [],
    folderAllow: [],
    folderBlock: ['Junk Email'],
    attachmentKeepExt: ['pdf'],
    attachmentMinImageKB: 50,
    dropInlineImages: true,
    senderBlockDomains: ['instructure.com', 'campuslabs.com', 'opal.so'],
    senderBlockLocalparts: ['noreply', 'notifications', 'marketing'],
    grayDomains: ['groups.nus.edu.sg', 'coursemology.org'],
    triageEnabled: true,
  },
};

describe('classifyOutlookSender', () => {
  it('blocks by exact and suffix domain match', () => {
    expect(classifyOutlookSender(clsCfg, { sender: 'notifications@instructure.com', isBulk: false })).toBe('block');
    expect(classifyOutlookSender(clsCfg, { sender: 'x@relay.engage.campuslabs.com', isBulk: false })).toBe('block');
  });
  it('blocks by localpart token', () => {
    expect(classifyOutlookSender(clsCfg, { sender: 'noreply@nus.edu.sg', isBulk: false })).toBe('block');
  });
  it('greys mailing-list prefixes and grayDomains', () => {
    expect(classifyOutlookSender(clsCfg, { sender: 'hwb_nusstudents@groups.nus.edu.sg', isBulk: false })).toBe('gray');
    expect(classifyOutlookSender(clsCfg, { sender: 'info@coursemology.org', isBulk: false })).toBe('gray');
  });
  it('greys a personal address only when a bulk signal is present', () => {
    expect(classifyOutlookSender(clsCfg, { sender: 'friend@gmail.com', isBulk: false })).toBe('keep');
    expect(classifyOutlookSender(clsCfg, { sender: 'friend@gmail.com', isBulk: true })).toBe('gray');
  });
  it('keeps internal Exchange X.500 senders (no domain)', () => {
    expect(classifyOutlookSender(clsCfg, { sender: '/o=exchangelabs/ou=.../cn=abc', isBulk: false })).toBe('keep');
  });
  it('block wins over a bulk signal', () => {
    expect(classifyOutlookSender(clsCfg, { sender: 'marketing@opal.so', isBulk: true })).toBe('block');
  });
});

describe('outlookBlockReason', () => {
  it('reports the matched domain', () => {
    expect(outlookBlockReason(clsCfg, 'notifications@instructure.com')).toBe('blocklist:instructure.com');
  });
  it('reports the matched localpart token when no domain matched', () => {
    expect(outlookBlockReason(clsCfg, 'noreply@nus.edu.sg')).toBe('blocklist:noreply');
  });
});
