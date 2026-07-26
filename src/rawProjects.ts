import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { cfg } from './config.js';

/**
 * slug → the folder that receives shelved raw files.
 * Project folders under 1_Projects\<slug> shelve into a raw\ subfolder so working files and
 * the frozen archive stay separate; the flat categories shelve straight into their folder.
 */
export function rawTargets(desktopDir = cfg.desktopDir): Record<string, string> {
  const targets: Record<string, string> = {};
  const projectsRoot = path.join(desktopDir, '1_Projects');
  if (existsSync(projectsRoot)) {
    for (const name of readdirSync(projectsRoot)) {
      const dir = path.join(projectsRoot, name);
      try {
        if (statSync(dir).isDirectory()) targets[name] = path.join(dir, 'raw');
      } catch {
        /* unreadable entry — skip */
      }
    }
  }
  targets.academic = path.join(desktopDir, '2_Academic');
  targets.general = path.join(desktopDir, '3_General');
  return targets;
}

/** Slugs a file can be shelved under — every project folder plus the flat categories. */
export function listShelvableProjects(desktopDir = cfg.desktopDir): string[] {
  return Object.keys(rawTargets(desktopDir));
}
