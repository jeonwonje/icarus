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
}
export interface SourcesConfig {
  canvas: CanvasFilter;
  outlook: OutlookFilter;
}

const DEFAULT_KEEP_EXT = [
  'pdf', 'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt',
  'csv', 'txt', 'md', 'zip', 'stl', 'eml', 'mp4',
];

const DEFAULTS: SourcesConfig = {
  canvas: { courses: [], modules: [] },
  outlook: {
    senderAllow: [],
    folderAllow: [],
    folderBlock: ['Junk Email'],
    attachmentKeepExt: DEFAULT_KEEP_EXT,
    attachmentMinImageKB: 50,
    dropInlineImages: true,
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
