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
}
export interface SourcesConfig {
  canvas: CanvasFilter;
  outlook: OutlookFilter;
}

const DEFAULTS: SourcesConfig = {
  canvas: { courses: [], modules: [] },
  outlook: { senderAllow: [], folderAllow: [], folderBlock: ['Junk Email'] },
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
