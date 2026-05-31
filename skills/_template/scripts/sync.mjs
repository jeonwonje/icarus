import fs from 'node:fs';
import path from 'node:path';

/** Resolve the hub root: explicit arg, else walk up to a `.claude`/`CLAUDE.md`, else cwd. */
export function resolveHubDir(arg, cwd = process.cwd()) {
  if (arg) return path.resolve(arg);
  let dir = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.claude')) || fs.existsSync(path.join(dir, 'CLAUDE.md'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(cwd);
}

/**
 * Implement me: list items from the source, dedup against a manifest, and write
 * new/changed items into <hubDir>/<domain>/<subject>/<source>/ (read-only),
 * ensuring a sibling user/ dir. Return a summary object.
 */
export async function syncSource(_cfg, _opts) {
  throw new Error('syncSource not implemented — copy skills/canvas as a reference');
}

async function main() {
  const hubDir = resolveHubDir(process.argv[2]);
  console.error(`(template) hub → ${hubDir}`);
  console.error('Not implemented. Copy skills/canvas/scripts/sync.mjs as a starting point.');
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main();
}
