# User-specified extra sandbox mounts

**Date:** 2026-05-30
**Status:** Approved, ready for implementation
**Builds on:** `2026-05-30-agent-sandbox-design.md`

## Problem

The agent sandbox makes the whole filesystem read-only except `data/`, the
`raw/` target, and `~/.claude`. The operator wants the bot to directly *write*
into specific Windows folders (e.g. their OneDrive at
`/mnt/c/Users/jeonw/OneDrive - National University of Singapore`) — to file
sources there. Today those paths are readable (via the ro-bind) but not
writable, and `.lnk` shortcuts are opaque data files, not symlinks the OS
follows. The operator wants an explicit allowlist of extra directories that get
bind-mounted read-write into the sandbox and surfaced under `raw/`.

## Goal / non-goals

- **Goal:** an operator-specified list of absolute paths that become read-write
  bind mounts in the sandbox and appear as `raw/<name>/` for the bot.
- **Goal:** leave the existing `data/raw` → `RAW_DIR` symlink untouched.
- **Non-goal:** auto-discovery of paths, per-path read-only/read-write mixing
  (all extra mounts are read-write), Windows `.lnk` parsing.

## Config: `SANDBOX_MOUNTS`

One `.env` line, `name=path` entries separated by `;`:

```
SANDBOX_MOUNTS=onedrive=/mnt/c/Users/jeonw/OneDrive - National University of Singapore;docs=/mnt/c/Users/jeonw/Documents
```

- `name` — the short label; becomes the symlink `raw/<name>` and how the bot
  cites it. Must be non-empty and contain no `/`.
- `path` — absolute target path; may contain spaces.
- Entries failing validation are logged and skipped; the bot still starts.

## Components

### `src/sandbox.ts`

- `export interface SandboxMount { name: string; target: string }`
- `parseSandboxMounts(raw: string): SandboxMount[]` — pure. Split on `;`, each
  on the first `=`. Trim. Keep an entry only when `name` is non-empty, has no
  `/`, and `target` is absolute (`path.isAbsolute`). Ignore empty segments.
- `buildSandboxArgs` opts gains `extraMounts?: string[]` (absolute target
  paths). For each, append `--bind-try <target> <target>` (read-write) UNLESS
  the target is nested in `dataDir`, nested in / equal to `rawTarget`, or a
  duplicate of an already-added extra mount. `--bind-try` (not `--bind`) so a
  temporarily-absent target doesn't abort the spawn.

### `src/memory/scaffold.ts`

- `ensureSandboxMounts(mounts: SandboxMount[]): boolean` — for each mount,
  manage `path.join(rawDir(), name)`:
  - target missing (`fs.existsSync(target)` false) → `logger.warn`, skip.
  - link path absent → `fs.symlinkSync(target, link)`.
  - link path is an existing symlink → if it points elsewhere, recreate
    (`fs.unlinkSync` + `symlinkSync`) so editing `.env` re-points it.
  - link path is a real file/dir → `logger.warn` ("refusing to overwrite"),
    skip.
  - Returns true if it created/changed anything.
- Called from `ensureDataLayout()` after `ensureRawLink()`, using
  `parseSandboxMounts(SANDBOX_MOUNTS)`.

### `src/config.ts`

- Add `SANDBOX_MOUNTS` to the `readEnvFile` key list and export the raw string
  (default `''`). Parsing lives in `sandbox.ts`, not here.

### `src/agent-runner.ts`

- When sandboxing, pass `extraMounts: parseSandboxMounts(SANDBOX_MOUNTS).map(m => m.target)`
  into `buildSandboxArgs`.

### No change needed

`bootstrap.ts` `listRawTree` already includes symlinked dirs
(`e.isSymbolicLink()`), so `raw/<name>/` surfaces in `<raw_folders>`
automatically. `listNewSources` only lists files, so the symlink-to-dir won't
mis-surface as a new source.

## Data flow

```
bot writes data/raw/onedrive/foo.pdf
  -> kernel resolves raw/onedrive symlink -> /mnt/c/.../OneDrive.../foo.pdf
  -> target bound read-write in sandbox (--bind-try)
  -> write lands in real OneDrive
```

## Error handling

- Invalid `SANDBOX_MOUNTS` entry → skipped + logged; bot starts.
- Target missing at startup → no symlink created, warn; the bind is also skipped
  by `--bind-try` at turn time.
- Target vanishes between startup and a turn → `--bind-try` tolerates it.
- Real file/dir already at `raw/<name>` → never overwritten; warn + skip.

## Testing

`test/sandbox.test.ts`:
- `parseSandboxMounts`: single entry; multiple `;`-separated; path with spaces;
  empty input → `[]`; entry with empty name skipped; entry with `/` in name
  skipped; relative target skipped; whitespace trimmed.
- `buildSandboxArgs` with `extraMounts`: target appears as a `--bind-try` rw
  pair; a target nested in `dataDir` is omitted; a target inside `rawTarget` is
  omitted; duplicate targets bound once; empty/undefined `extraMounts` leaves
  output unchanged.

Live mount behaviour was verified manually (drvfs symlink resolves; write
through the bound target succeeds); not re-run in CI.

## Security (unchanged posture)

Extra mounts are operator-specified but read-write, and the agent runs
`bypassPermissions`. A Telegram message could make the bot modify or delete real
files in these dirs. This is the deliberate trade-off chosen with read-write
access; documented in `.env.example` and `CLAUDE.md`.

## Docs

- `.env.example`: add `SANDBOX_MOUNTS` with format + read-write warning.
- `CLAUDE.md`: note that `SANDBOX_MOUNTS` adds read-write `raw/<name>` mounts.
