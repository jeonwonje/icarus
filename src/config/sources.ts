import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT } from '../core/config.js';
import { logger } from '../core/logger.js';

export interface CanvasFilter {
  courses: string[];
  modules: string[];
}
export interface OutlookFilter {
  senderAllow: string[];
  folderAllow: string[];
  folderBlock: string[];
  attachmentKeepExt: string[];
  attachmentMinImageKB: number;
  dropInlineImages: boolean;
  senderBlockDomains: string[];
  senderBlockLocalparts: string[];
  grayDomains: string[];
  triageEnabled: boolean;
}
export interface SourcesConfig {
  canvas: CanvasFilter;
  outlook: OutlookFilter;
}

const DEFAULT_KEEP_EXT = [
  'pdf', 'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt',
  'csv', 'txt', 'md', 'zip', 'stl', 'eml', 'mp4',
];
const DEFAULT_BLOCK_DOMAINS = [
  'instructure.com', 'csm.symplicity.com', 'symplicity.com', 'campuslabs.com',
  'examsoft.com', 'autodeskcommunications.com', 'opal.so',
];
const DEFAULT_BLOCK_LOCALPARTS = [
  'noreply', 'no-reply', 'donotreply', 'notifications', 'mailer', 'bounce',
  'newsletter', 'marketing', 'alerts',
];
const DEFAULT_GRAY_DOMAINS = ['groups.nus.edu.sg', 'coursemology.org'];

const DEFAULTS: SourcesConfig = {
  canvas: { courses: [], modules: [] },
  outlook: {
    senderAllow: [],
    folderAllow: [],
    folderBlock: ['Junk Email'],
    attachmentKeepExt: DEFAULT_KEEP_EXT,
    attachmentMinImageKB: 50,
    dropInlineImages: true,
    senderBlockDomains: DEFAULT_BLOCK_DOMAINS,
    senderBlockLocalparts: DEFAULT_BLOCK_LOCALPARTS,
    grayDomains: DEFAULT_GRAY_DOMAINS,
    triageEnabled: true,
  },
};

function arr(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : [];
}

export function loadSourcesConfig(file?: string): SourcesConfig {
  const target = file ?? path.join(PROJECT_ROOT, 'sources.config.json');
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(fs.readFileSync(target, 'utf-8'));
  } catch (err) {
    logger.warn({ err, target }, 'sources.config.json missing or invalid — using defaults');
    return DEFAULTS;
  }
  const canvas = (parsed.canvas ?? {}) as Record<string, unknown>;
  const outlook = (parsed.outlook ?? {}) as Record<string, unknown>;
  return {
    canvas: { courses: arr(canvas.courses), modules: arr(canvas.modules) },
    outlook: {
      senderAllow: arr(outlook.senderAllow),
      folderAllow: arr(outlook.folderAllow),
      folderBlock: outlook.folderBlock === undefined ? ['Junk Email'] : arr(outlook.folderBlock),
      attachmentKeepExt:
        outlook.attachmentKeepExt === undefined
          ? DEFAULT_KEEP_EXT
          : arr(outlook.attachmentKeepExt).map((s) => s.toLowerCase()),
      attachmentMinImageKB:
        typeof outlook.attachmentMinImageKB === 'number' ? outlook.attachmentMinImageKB : 50,
      dropInlineImages:
        outlook.dropInlineImages === undefined ? true : Boolean(outlook.dropInlineImages),
      senderBlockDomains:
        outlook.senderBlockDomains === undefined
          ? DEFAULT_BLOCK_DOMAINS
          : arr(outlook.senderBlockDomains).map((s) => s.toLowerCase()),
      senderBlockLocalparts:
        outlook.senderBlockLocalparts === undefined
          ? DEFAULT_BLOCK_LOCALPARTS
          : arr(outlook.senderBlockLocalparts).map((s) => s.toLowerCase()),
      grayDomains:
        outlook.grayDomains === undefined
          ? DEFAULT_GRAY_DOMAINS
          : arr(outlook.grayDomains).map((s) => s.toLowerCase()),
      triageEnabled:
        outlook.triageEnabled === undefined ? true : Boolean(outlook.triageEnabled),
    },
  };
}

export function canvasCourseAllowed(cfg: SourcesConfig, courseId: string): boolean {
  return cfg.canvas.courses.length === 0 || cfg.canvas.courses.includes(courseId);
}

export function outlookFolderAllowed(cfg: SourcesConfig, folder: string): boolean {
  if (cfg.outlook.folderBlock.includes(folder)) return false;
  return cfg.outlook.folderAllow.length === 0 || cfg.outlook.folderAllow.includes(folder);
}

export function outlookSenderAllowed(cfg: SourcesConfig, sender: string): boolean {
  return cfg.outlook.senderAllow.length === 0 || cfg.outlook.senderAllow.includes(sender);
}

const IMAGE_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'tif', 'tiff', 'svg', 'jfif', 'heic',
]);

export interface AttachmentMeta {
  ext: string;        // lowercased, no leading dot; '' if none
  contentId: string;  // '' if none
  mimeTag: string;    // '' if none
  sizeBytes: number;
}

function isImageAttachment(a: AttachmentMeta): boolean {
  return IMAGE_EXT.has(a.ext) || a.mimeTag.toLowerCase().startsWith('image/');
}

export function outlookAttachmentAllowed(cfg: SourcesConfig, a: AttachmentMeta): boolean {
  // Real documents are always kept, even when embedded inline (cid invoices etc.).
  if (a.ext && cfg.outlook.attachmentKeepExt.includes(a.ext)) return true;
  if (isImageAttachment(a)) {
    if (cfg.outlook.dropInlineImages && a.contentId) return false; // inline signature/screenshot
    return a.sizeBytes > cfg.outlook.attachmentMinImageKB * 1024;   // standalone image, by size
  }
  return false; // p7m, mso, emz, unnamed blobs, everything else
}

export interface SenderClassifyInput {
  sender: string;
  isBulk: boolean;
}

/** Lowercased domain after the last '@'; '' for X.500/no-domain senders. */
function senderDomain(sender: string): string {
  const s = (sender || '').toLowerCase().trim();
  const at = s.lastIndexOf('@');
  return at < 0 ? '' : s.slice(at + 1);
}

/** Lowercased local-part before the last '@'; the whole string if no '@'. */
function senderLocalpart(sender: string): string {
  const s = (sender || '').toLowerCase().trim();
  const at = s.lastIndexOf('@');
  return at < 0 ? s : s.slice(0, at);
}

/** Suffix match: 'relay.engage.campuslabs.com' matches a 'campuslabs.com' entry. */
function domainMatches(domain: string, list: string[]): boolean {
  return list.some((d) => domain === d || domain.endsWith('.' + d));
}

export function classifyOutlookSender(
  cfg: SourcesConfig,
  input: SenderClassifyInput,
): 'block' | 'keep' | 'gray' {
  const domain = senderDomain(input.sender);
  const local = senderLocalpart(input.sender);
  // BLOCK wins.
  if (domain && domainMatches(domain, cfg.outlook.senderBlockDomains)) return 'block';
  if (cfg.outlook.senderBlockLocalparts.some((t) => local.includes(t))) return 'block';
  // GRAY: bulk-ish ambiguous mail.
  if (input.isBulk) return 'gray';
  if (domain && (domain.startsWith('groups.') || domain.startsWith('lists.'))) return 'gray';
  if (domain && domainMatches(domain, cfg.outlook.grayDomains)) return 'gray';
  // KEEP: personal/human mail, X.500 internal senders.
  return 'keep';
}

/** Why a sender was blocked, for quarantine frontmatter. Assumes verdict was 'block'. */
export function outlookBlockReason(cfg: SourcesConfig, sender: string): string {
  const domain = senderDomain(sender);
  if (domain) {
    const d = cfg.outlook.senderBlockDomains.find((x) => domain === x || domain.endsWith('.' + x));
    if (d) return `blocklist:${d}`;
  }
  const local = senderLocalpart(sender);
  const t = cfg.outlook.senderBlockLocalparts.find((x) => local.includes(x));
  if (t) return `blocklist:${t}`;
  return 'blocklist:unknown';
}
