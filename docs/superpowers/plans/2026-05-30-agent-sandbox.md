# Agent FS Sandbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Confine the per-turn `claude` subprocess inside a bubblewrap sandbox so it can read/write only `data/` and the resolved `raw/` target, never the icarus source.

**Architecture:** A new pure module `src/sandbox.ts` builds the `bwrap` argv prefix (read-only `/` base + read-write binds for `data/`, the external `raw` target, and `~/.claude` state). `agent-runner.ts` composes `[bwrap, ...sandboxArgs, claude, ...claudeArgs]` when sandboxing is enabled, gated by `AGENT_SANDBOX` (auto/on/off). Everything else in the run loop is untouched.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node `child_process`, `fs`, `path`; Vitest; bubblewrap (`/usr/bin/bwrap`).

---

## File Structure

- **Create `src/sandbox.ts`** — pure sandbox logic: `buildSandboxArgs`, `resolveRawTarget`, `sandboxMode`, `bwrapPath`, `shouldSandbox`. No spawning, no side effects beyond reading env / filesystem metadata.
- **Create `test/sandbox.test.ts`** — unit tests for `buildSandboxArgs` and the raw-containment logic.
- **Modify `src/agent-runner.ts`** — compose the bwrap prefix around the existing `spawn`.
- **Modify `CLAUDE.md`** — document the sandbox + `AGENT_SANDBOX`.
- **Modify `.env.example`** — add `AGENT_SANDBOX`.

Conventions to follow (from existing code): two-space indent, ESM imports ending in `.js`, named exports, `import fs from 'fs'` / `import path from 'path'` style, `logger` from `./logger.js`. Tests use Vitest (`import { describe, it, expect } from 'vitest'`) — match `test/scaffold.test.ts`.

---

### Task 1: Pure `buildSandboxArgs` builder + raw containment

**Files:**
- Create: `src/sandbox.ts`
- Test: `test/sandbox.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/sandbox.test.ts`:

```typescript
import path from 'path';

import { describe, it, expect } from 'vitest';

import { buildSandboxArgs } from '../src/sandbox.js';

const DATA = '/home/jeon/icarus/data';
const HOME = '/home/jeon';

// Find the value following the first matching flag occurrence.
function bindPairs(args: string[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--bind') pairs.push([args[i + 1], args[i + 2]]);
  }
  return pairs;
}

describe('buildSandboxArgs', () => {
  it('mounts the whole fs read-only before any writable bind', () => {
    const a = buildSandboxArgs({ dataDir: DATA, rawTarget: null, home: HOME });
    const ro = a.indexOf('--ro-bind');
    expect(ro).toBeGreaterThanOrEqual(0);
    expect(a[ro + 1]).toBe('/');
    expect(a[ro + 2]).toBe('/');
    // first --bind comes after the ro base
    expect(a.indexOf('--bind')).toBeGreaterThan(ro);
  });

  it('binds data/ read-write', () => {
    const a = buildSandboxArgs({ dataDir: DATA, rawTarget: null, home: HOME });
    expect(bindPairs(a)).toContainEqual([DATA, DATA]);
  });

  it('binds an external raw target read-write', () => {
    const raw = '/mnt/c/Users/jeonw/Desktop/icarus-raw';
    const a = buildSandboxArgs({ dataDir: DATA, rawTarget: raw, home: HOME });
    expect(bindPairs(a)).toContainEqual([raw, raw]);
  });

  it('omits a raw target nested inside data/', () => {
    const raw = path.join(DATA, 'raw');
    const a = buildSandboxArgs({ dataDir: DATA, rawTarget: raw, home: HOME });
    expect(bindPairs(a)).not.toContainEqual([raw, raw]);
  });

  it('omits the raw bind when rawTarget is null', () => {
    const a = buildSandboxArgs({ dataDir: DATA, rawTarget: null, home: HOME });
    const raws = bindPairs(a).filter(([s]) => s.includes('raw'));
    expect(raws).toEqual([]);
  });

  it('binds ~/.claude and ~/.claude.json read-write', () => {
    const a = buildSandboxArgs({ dataDir: DATA, rawTarget: null, home: HOME });
    const pairs = bindPairs(a);
    expect(pairs).toContainEqual([path.join(HOME, '.claude'), path.join(HOME, '.claude')]);
    expect(pairs).toContainEqual([path.join(HOME, '.claude.json'), path.join(HOME, '.claude.json')]);
  });

  it('never makes the source tree writable', () => {
    const a = buildSandboxArgs({ dataDir: DATA, rawTarget: null, home: HOME });
    const src = '/home/jeon/icarus/src';
    expect(bindPairs(a).some(([s]) => s === src)).toBe(false);
  });

  it('chdirs into data/ and dies with parent', () => {
    const a = buildSandboxArgs({ dataDir: DATA, rawTarget: null, home: HOME });
    const chdir = a.indexOf('--chdir');
    expect(chdir).toBeGreaterThanOrEqual(0);
    expect(a[chdir + 1]).toBe(DATA);
    expect(a).toContain('--die-with-parent');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- sandbox`
Expected: FAIL — cannot resolve `../src/sandbox.js` / `buildSandboxArgs is not a function`.

- [ ] **Step 3: Write minimal implementation**

Create `src/sandbox.ts` (only the builder for now; other exports added in Task 2):

```typescript
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

  // raw/ lives outside data/ in the normal Windows-Desktop case; bind its
  // resolved target read-write. When it resolves inside data/ (off-Windows
  // fallback) the data/ bind already covers it.
  if (rawTarget && !isInside(dataDir, rawTarget)) {
    args.push('--bind', rawTarget, rawTarget);
  }

  // Claude needs to write session transcripts and refresh credentials.
  args.push('--bind', path.join(home, '.claude'), path.join(home, '.claude'));
  args.push('--bind', path.join(home, '.claude.json'), path.join(home, '.claude.json'));

  args.push('--chdir', dataDir, '--die-with-parent');
  return args;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- sandbox`
Expected: PASS (8 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/sandbox.ts test/sandbox.test.ts
git commit -m "feat(sandbox): pure bwrap arg builder with raw containment"
```

---

### Task 2: Gating helpers (`resolveRawTarget`, `sandboxMode`, `bwrapPath`, `shouldSandbox`)

**Files:**
- Modify: `src/sandbox.ts`
- Test: `test/sandbox.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/sandbox.test.ts`:

```typescript
import { sandboxMode } from '../src/sandbox.js';

describe('sandboxMode', () => {
  const prev = process.env.AGENT_SANDBOX;
  afterEach(() => {
    if (prev === undefined) delete process.env.AGENT_SANDBOX;
    else process.env.AGENT_SANDBOX = prev;
  });

  it('defaults to auto when unset', () => {
    delete process.env.AGENT_SANDBOX;
    expect(sandboxMode()).toBe('auto');
  });

  it('reads on/off/auto case-insensitively', () => {
    process.env.AGENT_SANDBOX = 'ON';
    expect(sandboxMode()).toBe('on');
    process.env.AGENT_SANDBOX = '0';
    expect(sandboxMode()).toBe('off');
    process.env.AGENT_SANDBOX = '1';
    expect(sandboxMode()).toBe('on');
    process.env.AGENT_SANDBOX = 'off';
    expect(sandboxMode()).toBe('off');
  });
});
```

Add `afterEach` to the existing vitest import at the top of the file:
`import { describe, it, expect, afterEach } from 'vitest';`

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- sandbox`
Expected: FAIL — `sandboxMode is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/sandbox.ts`:

```typescript
import fs from 'fs';
import { execFileSync } from 'child_process';

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
  // auto
  return { enabled: Boolean(bwrap), bwrap };
}
```

Move the `import path from 'path';` line to sit alongside the new `import fs` / `import { execFileSync }` lines at the top of the file (keep a single import block; ESM requires top-level imports).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- sandbox`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/sandbox.ts test/sandbox.test.ts
git commit -m "feat(sandbox): AGENT_SANDBOX gating + raw/bwrap resolution"
```

---

### Task 3: Wire the sandbox into `agent-runner.ts`

**Files:**
- Modify: `src/agent-runner.ts` (imports near top; spawn block at lines ~48-67)

- [ ] **Step 1: Add imports**

At the top of `src/agent-runner.ts`, alongside the existing imports, add:

```typescript
import os from 'os';

import { buildSandboxArgs, resolveRawTarget, shouldSandbox } from './sandbox.js';
```

- [ ] **Step 2: Compose the sandboxed command before `spawn`**

In `runAgentInner`, the current code is:

```typescript
  if (input.sessionId) args.push('--resume', input.sessionId);

  logger.info({ sessionId: input.sessionId, cwd }, 'Spawning agent');

  return new Promise<AgentOutput>((resolve) => {
    const proc: ChildProcess = spawn(CLAUDE_BIN, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
```

Replace it with:

```typescript
  if (input.sessionId) args.push('--resume', input.sessionId);

  const decision = shouldSandbox();
  if (decision.error) {
    return { status: 'error', result: null, error: decision.error };
  }

  let command = CLAUDE_BIN;
  let commandArgs = args;
  if (decision.enabled && decision.bwrap) {
    const sandboxArgs = buildSandboxArgs({
      dataDir: cwd,
      rawTarget: resolveRawTarget(cwd),
      home: os.homedir(),
    });
    command = decision.bwrap;
    commandArgs = [...sandboxArgs, CLAUDE_BIN, ...args];
  }

  logger.info(
    { sessionId: input.sessionId, cwd, sandbox: decision.enabled },
    'Spawning agent',
  );

  return new Promise<AgentOutput>((resolve) => {
    const proc: ChildProcess = spawn(command, commandArgs, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
```

Note: `cwd` here is `input.cwd ?? dataDir()` (already computed at the top of `runAgentInner`) — it is the data dir, which is what the sandbox makes writable and chdirs into.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Lint (if configured)**

Run: `npm run lint --if-present`
Expected: no errors (or command absent).

- [ ] **Step 5: Full test suite**

Run: `npm test`
Expected: all suites PASS (existing + sandbox).

- [ ] **Step 6: Commit**

```bash
git add src/agent-runner.ts
git commit -m "feat(sandbox): spawn claude inside bwrap when enabled"
```

---

### Task 4: Live smoke test of the sandbox wall

**Files:** none (manual verification)

- [ ] **Step 1: Confirm the wall blocks writes to src/ but allows data/**

Run this exact command (mirrors what `buildSandboxArgs` produces, with the real
data dir and home), attempting one write outside and one inside the allowed set:

```bash
bwrap --ro-bind / / --dev /dev --proc /proc --bind /tmp /tmp \
  --bind /home/jeon/icarus/data /home/jeon/icarus/data \
  --bind "$HOME/.claude" "$HOME/.claude" \
  --bind "$HOME/.claude.json" "$HOME/.claude.json" \
  --chdir /home/jeon/icarus/data --die-with-parent \
  bash -lc 'echo blocked > /home/jeon/icarus/src/SANDBOX_PROBE 2>&1; echo "src rc=$?"; echo ok > ./SANDBOX_PROBE && echo "data rc=$?" && rm -f ./SANDBOX_PROBE'
```

Expected output:
```
bash: line 1: /home/jeon/icarus/src/SANDBOX_PROBE: Read-only file system
src rc=1
data rc=0
```

If `src rc=0` appears, STOP — the wall is not holding; re-check the mount order
in `buildSandboxArgs` before proceeding.

- [ ] **Step 2: Verify no stray probe file leaked into src/**

Run: `ls /home/jeon/icarus/src/SANDBOX_PROBE 2>&1`
Expected: `No such file or directory`.

---

### Task 5: Docs — `CLAUDE.md` + `.env.example`

**Files:**
- Modify: `CLAUDE.md` (the "Conventions" section)
- Modify: `.env.example`

- [ ] **Step 1: Document the sandbox in CLAUDE.md**

In `CLAUDE.md`, under the `## Conventions` list, add a bullet:

```markdown
- The per-turn `claude` subprocess runs inside a bubblewrap (`bwrap`) sandbox:
  the whole filesystem is read-only except `data/`, the resolved `raw/` target,
  and `~/.claude` state. This is the FS wall that stops the agent editing its
  own source. Toggle with `AGENT_SANDBOX` (`auto` default — on when `bwrap` is
  present on Linux; `on` to require it; `off` to disable).
```

- [ ] **Step 2: Add AGENT_SANDBOX to .env.example**

Append to `.env.example`:

```
# Sandbox the per-turn claude subprocess with bubblewrap so it can only write
# data/ and the raw/ tree. auto (default) = on when bwrap is available on Linux;
# on = require bwrap (error if missing); off = disable.
AGENT_SANDBOX=auto
```

- [ ] **Step 3: Verify .env.example is tracked and edited**

Run: `git diff --stat CLAUDE.md .env.example`
Expected: both files show insertions.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md .env.example
git commit -m "docs(sandbox): document AGENT_SANDBOX and the bwrap wall"
```

---

## Self-Review

**Spec coverage:**
- Mechanism (bwrap wrap, bypassPermissions kept) → Task 1 + Task 3. ✓
- Mount table (ro `/`, dev, proc, tmp, data, raw, ~/.claude, chdir, die-with-parent) → Task 1. ✓
- raw symlink containment (external bind / nested omit / null omit) → Task 1 tests + impl. ✓
- `src/sandbox.ts` pure builder + `resolveRawTarget`/`sandboxMode`/`bwrapPath` → Tasks 1-2. ✓
- agent-runner wiring + `{ sandbox }` log → Task 3. ✓
- Gating `AGENT_SANDBOX` (auto/on/off, forced-on error, auto-fallback warn) → Task 2 (`shouldSandbox`) + Task 3 (error short-circuit). ✓
- weekly-prune inherits sandbox → no code needed (calls runAgent). ✓
- Tests (8 builder assertions + mode) → Tasks 1-2; full suite green → Task 3. ✓
- Live wall verification → Task 4. ✓
- Docs (CLAUDE.md + .env.example) → Task 5. ✓

**Placeholder scan:** no TBD/TODO; every code + command step is concrete. ✓

**Type consistency:** `buildSandboxArgs(SandboxOpts)`, `shouldSandbox(): SandboxDecision` with `{enabled,bwrap,error}`, `resolveRawTarget(dataDir)`, `sandboxMode(): 'on'|'off'|'auto'` — names/signatures used identically in Task 3. ✓

---

## Execution Handoff

Per the user's instruction ("all the way to subagent-driven execution"), proceed with **subagent-driven development**: one fresh subagent per task, two-stage review between tasks. After Task 5 passes and the branch is green, restart the icarus systemd service.
