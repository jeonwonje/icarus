import fs from 'fs';
import { execFileSync } from 'child_process';
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

export type SandboxMode = 'on' | 'off' | 'auto';

/** Read AGENT_SANDBOX: 1/on -> on, 0/off -> off, anything else -> auto. */
export function sandboxMode(): SandboxMode {
  const v = (process.env.AGENT_SANDBOX ?? '').trim().toLowerCase();
  if (v === '1' || v === 'on') return 'on';
  if (v === '0' || v === 'off') return 'off';
  return 'auto';
}

/** Resolve data/raw to its real absolute path, or null if it can't be resolved. */
export function resolveRawTarget(dataDir: string): string | null {
  try {
    return fs.realpathSync(path.join(dataDir, 'raw'));
  } catch {
    return null;
  }
}

let bwrapCache: string | null | undefined;
/** Absolute path to bwrap on PATH, or null. Cached after first lookup. */
export function bwrapPath(): string | null {
  if (bwrapCache !== undefined) return bwrapCache;
  try {
    bwrapCache = execFileSync('bash', ['-lc', 'command -v bwrap'], {
      encoding: 'utf8',
    }).trim() || null;
  } catch {
    bwrapCache = null;
  }
  return bwrapCache;
}

export interface SandboxDecision {
  enabled: boolean;
  bwrap: string | null;
  /** Set when mode is 'on' but bwrap is unavailable: hard error for the caller. */
  error?: string;
}

/** Decide whether to sandbox this spawn given mode + platform + bwrap. */
export function shouldSandbox(): SandboxDecision {
  const mode = sandboxMode();
  if (mode === 'off') return { enabled: false, bwrap: null };
  const bwrap = process.platform === 'linux' ? bwrapPath() : null;
  if (mode === 'on') {
    if (!bwrap) {
      return { enabled: false, bwrap: null, error: 'AGENT_SANDBOX=on but bwrap not found on PATH' };
    }
    return { enabled: true, bwrap };
  }
  return { enabled: Boolean(bwrap), bwrap };
}
