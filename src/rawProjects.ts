import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { cfg } from './config.js';
import { listWikiProjects } from './connectors/telegram/wikiProjects.js';

/** Wiki project slugs that also exist as Desktop folders — valid shelf targets. */
export function listShelvableProjects(
  wikiDir = cfg.wikiDir,
  desktopDir = cfg.desktopDir,
): string[] {
  return listWikiProjects(wikiDir)
    .map((p) => p.slug)
    .filter((slug) => {
      const dir = path.join(desktopDir, slug);
      try {
        return existsSync(dir) && statSync(dir).isDirectory();
      } catch {
        return false;
      }
    });
}
