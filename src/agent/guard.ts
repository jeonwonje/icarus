import os from 'node:os';
import path from 'node:path';
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { cfg, REFLECTION_JOB } from '../config.js';
import { log } from '../log.js';

const norm = (p: string) => path.resolve(p).toLowerCase();

const PROTECTED_FILES = [
  norm(path.join(cfg.desktopDir, 'CLAUDE.md')),
  norm(path.join(cfg.desktopDir, 'wiki', 'CLAUDE.md')),
];
const PROTECTED_DIRS = [norm(path.join(os.homedir(), '.claude'))];

// Reflection's write surface: persona files, new eval cases, and scratch space.
const REFLECTION_WRITABLE = [
  norm(cfg.personaDir),
  norm(cfg.evalCasesDir),
  norm(os.tmpdir()),
  norm(cfg.stateDir),
];

const BASH_DENY: { re: RegExp; reason: string }[] = [
  {
    re: /(rm\s+(-\w*r\w*f|\-\w*f\w*r)\w*|remove-item\s+[^|;]*-recurse)[^|;]*(wiki|\.claude)/i,
    reason: 'recursive delete touching the wiki or ~/.claude is not allowed',
  },
  { re: /\bshutdown\b/i, reason: 'shutting down the machine is not allowed' },
  { re: /\bformat(\.com)?\s+\w:/i, reason: 'formatting drives is not allowed' },
];

const inDir = (p: string, dir: string) => p === dir || p.startsWith(dir + path.sep);

function checkFilePath(fp: string, kind: string): string | null {
  const p = norm(fp);
  if (PROTECTED_FILES.includes(p)) return `${fp} is owner-managed; Icarus never edits it`;
  if (PROTECTED_DIRS.some((d) => inDir(p, d)))
    return 'nothing under ~/.claude may be written (creating a global CLAUDE.md included)';
  if (kind === `job:${REFLECTION_JOB}`) {
    if (!REFLECTION_WRITABLE.some((d) => inDir(p, d)))
      return 'the reflection job may only write persona files, eval cases, and scratch space — use propose_self_edit for persona changes';
  }
  return null;
}

/** Static PreToolUse deny rules. Small and reviewed as code — the counterweight to bypassPermissions. */
export function buildGuardHook(jid: string, kind: string): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
    let reason: string | null = null;

    if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(input.tool_name)) {
      const fp = toolInput.file_path ?? toolInput.notebook_path;
      if (typeof fp === 'string') reason = checkFilePath(fp, kind);
    } else if (input.tool_name === 'Bash') {
      const command = String(toolInput.command ?? '');
      const hit = BASH_DENY.find((d) => d.re.test(command));
      if (hit) reason = hit.reason;
      // Recursive delete aimed at the Desktop root itself (subfolders are fine).
      if (!reason && /(rm\s+-\w*r|remove-item\s+[^|;]*-recurse)/i.test(command)) {
        const lower = command.toLowerCase().replace(/\//g, '\\');
        const desktop = norm(cfg.desktopDir).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp(`${desktop}(?![\\\\\\w])`).test(lower))
          reason = 'recursive delete of the Desktop root is not allowed';
      }
    }

    if (reason) {
      log.warn({ jid, tool: input.tool_name, reason }, 'guard denied tool call');
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          permissionDecision: 'deny' as const,
          permissionDecisionReason: reason,
        },
      };
    }
    return {};
  };
}
