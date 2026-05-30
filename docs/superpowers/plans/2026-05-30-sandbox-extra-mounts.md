# Extra Sandbox Mounts Implementation Plan

> **For agentic workers:** execute task-by-task with TDD. Steps use `- [ ]`.

**Goal:** Let the operator add read-write `raw/<name>` mounts (e.g. OneDrive) to the sandbox via a `SANDBOX_MOUNTS` env list.

**Architecture:** Parse `SANDBOX_MOUNTS` (pure, in `sandbox.ts`), bind each target read-write via `buildSandboxArgs({extraMounts})`, and symlink `raw/<name>`→target at startup in `scaffold.ts`. `agent-runner.ts` threads the targets through. Mirrors the existing `RAW_DIR` machinery.

**Tech Stack:** TypeScript ESM (`.js` specifiers), Node `fs`/`path`, Vitest, bubblewrap.

---

### Task 1: `parseSandboxMounts` + `extraMounts` in `buildSandboxArgs`

**Files:** Modify `src/sandbox.ts`, `test/sandbox.test.ts`

- [ ] **Step 1: Tests (append to `test/sandbox.test.ts`; add `parseSandboxMounts` to the top import block)**

```typescript
describe('parseSandboxMounts', () => {
  it('parses a single name=path entry', () => {
    expect(parseSandboxMounts('onedrive=/mnt/c/OneDrive')).toEqual([
      { name: 'onedrive', target: '/mnt/c/OneDrive' },
    ]);
  });
  it('parses multiple ;-separated entries', () => {
    expect(parseSandboxMounts('a=/mnt/c/a;b=/mnt/c/b')).toEqual([
      { name: 'a', target: '/mnt/c/a' },
      { name: 'b', target: '/mnt/c/b' },
    ]);
  });
  it('keeps spaces in the target path', () => {
    expect(parseSandboxMounts('od=/mnt/c/One Drive - NUS')).toEqual([
      { name: 'od', target: '/mnt/c/One Drive - NUS' },
    ]);
  });
  it('trims whitespace around name and path', () => {
    expect(parseSandboxMounts(' od = /mnt/c/x ')).toEqual([{ name: 'od', target: '/mnt/c/x' }]);
  });
  it('returns [] for empty/whitespace input', () => {
    expect(parseSandboxMounts('')).toEqual([]);
    expect(parseSandboxMounts('   ')).toEqual([]);
  });
  it('skips entries with empty name, slash in name, or relative target', () => {
    expect(parseSandboxMounts('=/mnt/c/x')).toEqual([]);
    expect(parseSandboxMounts('a/b=/mnt/c/x')).toEqual([]);
    expect(parseSandboxMounts('rel=relative/path')).toEqual([]);
  });
  it('ignores empty segments from stray semicolons', () => {
    expect(parseSandboxMounts('a=/mnt/c/a;;')).toEqual([{ name: 'a', target: '/mnt/c/a' }]);
  });
});

describe('buildSandboxArgs extraMounts', () => {
  const DATA = '/home/jeon/icarus/data';
  const HOME = '/home/jeon';
  function bindTryPairs(args: string[]): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--bind-try') out.push([args[i + 1], args[i + 2]]);
    }
    return out;
  }
  it('binds an external extra mount read-write via --bind-try', () => {
    const a = buildSandboxArgs({ dataDir: DATA, rawTarget: null, home: HOME, extraMounts: ['/mnt/c/OneDrive'] });
    expect(bindTryPairs(a)).toContainEqual(['/mnt/c/OneDrive', '/mnt/c/OneDrive']);
  });
  it('omits an extra mount nested inside dataDir', () => {
    const a = buildSandboxArgs({ dataDir: DATA, rawTarget: null, home: HOME, extraMounts: [DATA + '/sub'] });
    expect(bindTryPairs(a)).not.toContainEqual([DATA + '/sub', DATA + '/sub']);
  });
  it('omits an extra mount inside the raw target', () => {
    const raw = '/mnt/c/raw';
    const a = buildSandboxArgs({ dataDir: DATA, rawTarget: raw, home: HOME, extraMounts: [raw + '/x'] });
    expect(bindTryPairs(a)).not.toContainEqual([raw + '/x', raw + '/x']);
  });
  it('binds a duplicate extra mount only once', () => {
    const a = buildSandboxArgs({ dataDir: DATA, rawTarget: null, home: HOME, extraMounts: ['/mnt/c/d', '/mnt/c/d'] });
    expect(bindTryPairs(a).filter(([s]) => s === '/mnt/c/d')).toHaveLength(1);
  });
  it('no extraMounts leaves output identical to before', () => {
    const base = buildSandboxArgs({ dataDir: DATA, rawTarget: null, home: HOME });
    const withEmpty = buildSandboxArgs({ dataDir: DATA, rawTarget: null, home: HOME, extraMounts: [] });
    expect(withEmpty).toEqual(base);
  });
});
```

- [ ] **Step 2: Run `npm test -- sandbox` → FAIL (parseSandboxMounts undefined / extraMounts ignored).**

- [ ] **Step 3: Implement in `src/sandbox.ts`.**

Add to `SandboxOpts`:
```typescript
export interface SandboxOpts {
  dataDir: string;
  rawTarget: string | null;
  home: string;
  extraMounts?: string[];
}

export interface SandboxMount {
  name: string;
  target: string;
}

/** Parse SANDBOX_MOUNTS: `name=path` entries separated by `;`. */
export function parseSandboxMounts(raw: string): SandboxMount[] {
  const out: SandboxMount[] = [];
  for (const seg of (raw ?? '').split(';')) {
    const s = seg.trim();
    if (!s) continue;
    const eq = s.indexOf('=');
    if (eq === -1) continue;
    const name = s.slice(0, eq).trim();
    const target = s.slice(eq + 1).trim();
    if (!name || name.includes('/') || !path.isAbsolute(target)) continue;
    out.push({ name, target });
  }
  return out;
}
```

In `buildSandboxArgs`, after the raw bind and before the `~/.claude` binds, add the extra mounts (dedup + containment):
```typescript
  const seen = new Set<string>();
  for (const target of opts.extraMounts ?? []) {
    if (seen.has(target)) continue;
    if (isInside(dataDir, target)) continue;
    if (rawTarget && isInside(rawTarget, target)) continue;
    seen.add(target);
    args.push('--bind-try', target, target);
  }
```
(Note: `buildSandboxArgs` already destructures `{ dataDir, rawTarget, home }`; reference `opts.extraMounts` directly, or add `extraMounts` to the destructure.)

- [ ] **Step 4: Run `npm test -- sandbox` → PASS. Run `npm run typecheck` → clean.**

- [ ] **Step 5: Commit** `git add src/sandbox.ts test/sandbox.test.ts && git commit -m "feat(sandbox): parse SANDBOX_MOUNTS and bind extra mounts rw"`

---

### Task 2: `SANDBOX_MOUNTS` in config + `ensureSandboxMounts` in scaffold

**Files:** Modify `src/config.ts`, `src/memory/scaffold.ts`, `test/scaffold.test.ts`

- [ ] **Step 1: config.ts** — add `'SANDBOX_MOUNTS'` to the `readEnvFile([...])` array and export:
```typescript
export const SANDBOX_MOUNTS = fromEnv('SANDBOX_MOUNTS') || '';
```

- [ ] **Step 2: Test (append to `test/scaffold.test.ts`).** Match the file's existing setup (it isolates `RAW_DIR`/`DATA_DIR` into a tmp dir — follow the same pattern for these tests; create a real tmp target dir and a tmp data dir, call `ensureSandboxMounts`, assert the symlink).

```typescript
import { ensureSandboxMounts } from '../src/memory/scaffold.js';
// inside a test that has tmp DATA_DIR with a raw/ dir and a separate tmp target:
it('symlinks raw/<name> to an existing target', () => {
  // target = a real tmp dir; data/raw exists (created by ensureDataLayout)
  ensureSandboxMounts([{ name: 'ext', target: TARGET }]);
  const link = path.join(RAW, 'ext');
  expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  expect(fs.realpathSync(link)).toBe(fs.realpathSync(TARGET));
});
it('skips a mount whose target does not exist', () => {
  ensureSandboxMounts([{ name: 'gone', target: path.join(TMP, 'nope') }]);
  expect(fs.existsSync(path.join(RAW, 'gone'))).toBe(false);
});
it('refuses to overwrite a real dir at raw/<name>', () => {
  const link = path.join(RAW, 'real');
  fs.mkdirSync(link);
  ensureSandboxMounts([{ name: 'real', target: TARGET }]);
  expect(fs.lstatSync(link).isSymbolicLink()).toBe(false); // untouched
});
```
(Adapt `RAW`, `TARGET`, `TMP`, `DATA_DIR` to the existing test harness in this file. If `ensureDataLayout` is already called in setup, `RAW = path.join(dataDir, 'raw')`.)

- [ ] **Step 3: Run the scaffold tests → FAIL (`ensureSandboxMounts` undefined).**

- [ ] **Step 4: Implement in `src/memory/scaffold.ts`.** Add import of `parseSandboxMounts`/`SandboxMount` from `../sandbox.js` and `SANDBOX_MOUNTS` from `../config.js`. Add:

```typescript
/**
 * For each operator-specified mount, ensure raw/<name> symlinks to its target.
 * Refreshes a stale symlink; never overwrites a real file/dir; skips a missing
 * target (the sandbox bind is --bind-try, so it tolerates absence too).
 */
export function ensureSandboxMounts(mounts: SandboxMount[]): boolean {
  let changed = false;
  for (const { name, target } of mounts) {
    if (!fs.existsSync(target)) {
      logger.warn({ name, target }, 'SANDBOX_MOUNTS target missing; skipping');
      continue;
    }
    const link = path.join(rawDir(), name);
    let existing: fs.Stats | null = null;
    try {
      existing = fs.lstatSync(link);
    } catch {
      existing = null;
    }
    if (!existing) {
      fs.symlinkSync(target, link);
      logger.info({ link, target }, 'sandbox mount symlinked');
      changed = true;
    } else if (existing.isSymbolicLink()) {
      if (fs.readlinkSync(link) !== target) {
        fs.unlinkSync(link);
        fs.symlinkSync(target, link);
        logger.info({ link, target }, 'sandbox mount symlink repointed');
        changed = true;
      }
    } else {
      logger.warn({ link }, 'raw/<name> is a real file/dir; refusing to overwrite');
    }
  }
  return changed;
}
```

In `ensureDataLayout()`, after `if (ensureRawLink()) created = true;` add:
```typescript
  if (ensureSandboxMounts(parseSandboxMounts(SANDBOX_MOUNTS))) created = true;
```

- [ ] **Step 5: Run `npm test` → all PASS. `npm run typecheck` → clean.**

- [ ] **Step 6: Commit** `git add src/config.ts src/memory/scaffold.ts test/scaffold.test.ts && git commit -m "feat(sandbox): symlink raw/<name> for SANDBOX_MOUNTS at startup"`

---

### Task 3: Wire extraMounts into the spawn

**Files:** Modify `src/agent-runner.ts`

- [ ] **Step 1:** Add import: `import { SANDBOX_MOUNTS } from './config.js';` and extend the sandbox import to include `parseSandboxMounts`:
```typescript
import { buildSandboxArgs, parseSandboxMounts, resolveRawTarget, shouldSandbox } from './sandbox.js';
```

- [ ] **Step 2:** In the `decision.enabled` branch, pass extraMounts:
```typescript
    const sandboxArgs = buildSandboxArgs({
      dataDir: cwd,
      rawTarget: resolveRawTarget(cwd),
      home: os.homedir(),
      extraMounts: parseSandboxMounts(SANDBOX_MOUNTS).map((m) => m.target),
    });
```

- [ ] **Step 3:** `npm run typecheck` → clean; `npm test` → all PASS.

- [ ] **Step 4: Commit** `git add src/agent-runner.ts && git commit -m "feat(sandbox): bind SANDBOX_MOUNTS targets into the spawn"`

---

### Task 4: Live verification + docs

**Files:** Modify `.env.example`, `CLAUDE.md`

- [ ] **Step 1: Docs.** `.env.example` — append:
```
# Extra directories the sandboxed bot can read AND WRITE, surfaced as raw/<name>.
# Format: name=abspath entries separated by ';'. Targets may contain spaces.
# WARNING: read-write + bypassPermissions means a Telegram message could modify
# or delete real files in these dirs (e.g. your OneDrive). Only list dirs you
# trust the bot with.
# Example: SANDBOX_MOUNTS=onedrive=/mnt/c/Users/you/OneDrive - Org;docs=/mnt/c/Users/you/Documents
SANDBOX_MOUNTS=
```
`CLAUDE.md` — under the sandbox bullet, add a sentence: `SANDBOX_MOUNTS=name=path;… adds read-write raw/<name> mounts (e.g. OneDrive) to the allowlist.`

- [ ] **Step 2: Commit** `git add .env.example CLAUDE.md && git commit -m "docs(sandbox): document SANDBOX_MOUNTS"`

- [ ] **Step 3: Live check (manual).** With a real `SANDBOX_MOUNTS=onedrive=/mnt/c/Users/jeonw/OneDrive - National University of Singapore` set, confirm `ensureSandboxMounts` makes the symlink and a write through `data/raw/onedrive/` lands in OneDrive (mirror the probe already run). Clean up any probe file.

---

## Self-Review

- Config format, parse rules, rw bind, symlink lifecycle, containment/dedup, error paths → Tasks 1–2 cover each spec section. ✓
- `bootstrap.ts` unchanged (symlink dirs already surface) — noted, no task. ✓
- Types: `SandboxMount {name,target}`, `parseSandboxMounts`, `extraMounts?: string[]`, `ensureSandboxMounts` — consistent across tasks. ✓
- No placeholders; test code concrete (scaffold tests adapt to the existing tmp harness, flagged explicitly). ✓
