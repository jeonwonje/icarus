import path from 'path';

export interface SandboxOpts {
  dataDir: string;
  rawTarget: string | null;
  home: string;
}

/** True when `child` is `parent` itself or nested under it. */
function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Build the `bwrap` argv prefix (everything up to and including
 * `--die-with-parent`). The caller composes:
 *   [bwrapBin, ...buildSandboxArgs(opts), claudeBin, ...claudeArgs]
 *
 * Whole fs is read-only; only data/, the external raw target, and the
 * caller's ~/.claude state are read-write.
 */
export function buildSandboxArgs(opts: SandboxOpts): string[] {
  const { dataDir, rawTarget, home } = opts;
  const args: string[] = [
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--proc', '/proc',
    '--bind', '/tmp', '/tmp',
    '--bind', dataDir, dataDir,
  ];

  if (rawTarget && !isInside(dataDir, rawTarget)) {
    args.push('--bind', rawTarget, rawTarget);
  }

  args.push('--bind', path.join(home, '.claude'), path.join(home, '.claude'));
  args.push('--bind', path.join(home, '.claude.json'), path.join(home, '.claude.json'));

  args.push('--chdir', dataDir, '--die-with-parent');
  return args;
}
