# Agent FS sandbox (bubblewrap)

**Date:** 2026-05-30
**Status:** Approved, ready for implementation

## Problem

The bot spawns `claude` per turn with `--permission-mode bypassPermissions`
(`src/agent-runner.ts`) and `cwd = data/`. `cwd` is not a confinement: the
subprocess inherits the full environment and can read/write any path, including
the bot's own source tree (`src/`, `package.json`, `.git`). A Telegram message
like "edit src/index.ts and commit" would execute end to end.

We want a real filesystem wall: the agent may freely read/write its working
content (`data/` and the `raw/` source tree) but must not be able to modify the
icarus source or anything else on the host — even via a `Bash`-based escape.

## Goal / non-goals

- **Goal:** kernel-enforced FS confinement of the `claude` subprocess so that
  everything outside the allowed write set is read-only.
- **Goal:** `data/` and the resolved `raw/` target remain read-write so the
  agent keeps working exactly as today.
- **Non-goal:** network restriction, CPU/memory limits, syscall filtering.
- **Non-goal:** protecting `~/.claude` global state (see Residual risk).

## Mechanism

Wrap the `claude` spawn in `bwrap` (bubblewrap 0.11.1, already installed at
`/usr/bin/bwrap`, verified working under this WSL2 kernel). The bwrap mount
table is the wall, so `--permission-mode bypassPermissions` stays unchanged —
the agent keeps full tool autonomy *inside the box*, and the box is enforced by
the kernel, not by Claude's own permission checks.

Rejected alternative: Claude permission deny-rules (drop `bypassPermissions`,
deny `Write`/`Edit` to the repo). Weaker — it trusts Claude's in-process
permission enforcement, and a prompt-injected `Bash` call could route around the
path matcher. We want an OS-level wall.

### Mount table

Applied in order; later binds override the read-only base:

```
--ro-bind / /                         # entire fs visible, READ-ONLY
--dev /dev
--proc /proc
--bind /tmp /tmp                      # writable scratch
--bind <DATA_DIR> <DATA_DIR>          # rw: wiki/, index.md, log.md, outbox/, skills/
--bind <RAW_TARGET> <RAW_TARGET>      # rw: ONLY if data/raw resolves outside DATA_DIR
--bind <HOME>/.claude <HOME>/.claude  # rw: session resume, transcripts, creds refresh
--bind <HOME>/.claude.json <HOME>/.claude.json  # rw: claude config/state
--chdir <DATA_DIR>
--die-with-parent
```

Net effect: the whole repo **except `data/`** is read-only. `src/`,
`package.json`, `.git`, `state/` can be read but never modified.

### The `raw` symlink subtlety

`data/raw` is a symlink to `RAW_DIR` (default
`/mnt/c/Users/jeonw/Desktop/icarus-raw`). Two cases, handled by resolving the
symlink and testing containment:

- Target **outside** `data/` (normal Windows case): needs its own rw `--bind`.
- Target **inside** `data/` (off-Windows fallback makes `data/raw` a real
  subdir): already covered by the `data/` bind — omit the extra bind.

If `data/raw` does not exist or cannot be resolved, omit the raw bind (the
`data/` bind still covers a future local `data/raw`).

## Components

### `src/sandbox.ts` (new)

Pure, side-effect-free arg construction so it is unit-testable without spawning:

```
buildSandboxArgs(opts: {
  dataDir: string;
  rawTarget: string | null;   // resolved data/raw target, or null
  home: string;
}): string[]
```

Returns the `bwrap` argv prefix (everything up to and including `--die-with-parent`).
It does NOT include `bwrap` itself or the `claude` command — the caller composes
`[BWRAP_BIN, ...buildSandboxArgs(...), CLAUDE_BIN, ...claudeArgs]`.

Containment helper: the raw `--bind` is included only when `rawTarget` is
non-null and is not equal to / nested under `dataDir`.

A separate concern from arg-building: resolving the raw target and deciding
whether sandboxing is enabled. Expose:

- `resolveRawTarget(dataDir): string | null` — `fs.realpathSync` on
  `data/raw`, returning the resolved absolute path or null on failure.
- `sandboxMode(): 'on' | 'off' | 'auto'` — read `AGENT_SANDBOX`.
- `bwrapPath(): string | null` — resolve `bwrap` on PATH (cache once).

### `src/agent-runner.ts` (modified)

In `runAgentInner`, after building `args`, decide whether to sandbox:

- Resolve mode from `AGENT_SANDBOX` and bwrap availability.
- If sandboxing: `spawn(BWRAP_BIN, [...sandboxArgs, CLAUDE_BIN, ...args], { cwd, ... })`.
  (`--chdir` inside bwrap sets the in-sandbox cwd; the outer `cwd` is harmless
  but kept for parity.)
- If not: `spawn(CLAUDE_BIN, args, ...)` exactly as today.

Everything else (stream parsing, timeouts, session retry) is unchanged. The
existing `SIGTERM` kill plus `--die-with-parent` ensure no orphaned sandboxes.

### Gating: `AGENT_SANDBOX`

- **unset / `auto` (default):** sandbox **on** when platform is Linux and
  `bwrap` resolves on PATH. If bwrap is missing, log a warning and run
  unsandboxed (do not brick the bot on other hosts).
- **`1` / `on`:** force on — hard error (`{status:'error'}`) if bwrap missing.
- **`0` / `off`:** force off — spawn `claude` directly.

Logged once per spawn at info level: `{ sandbox: true|false }`.

## Data flow

Unchanged from today except the spawned argv:

```
runTurn -> runAgent -> runAgentInner
  -> build claude args (-p, stream-json, bypassPermissions, [--resume])
  -> if sandbox: spawn bwrap [sandboxArgs claude ...args]
     else:       spawn claude args
  -> stream stdout JSON events -> onEvent -> Telegram
```

`scripts/weekly-prune.ts` calls `runAgent` too, so it is sandboxed identically
with no extra work.

## Error handling

- bwrap missing + forced on: return `{status:'error', error:'AGENT_SANDBOX=on but bwrap not found'}`.
- bwrap missing + auto: warn, fall through to unsandboxed spawn.
- raw target unresolvable: omit raw bind, proceed (data/ still writable).
- bwrap itself fails to start (`proc.on('error')`): already handled by the
  existing spawn-error path, surfaced as `spawn error: ...`.
- Stale-session retry path (`runAgent` wrapper) is unaffected — it re-calls
  `runAgentInner`, which re-derives the sandbox.

## Testing

New `test/sandbox.test.ts` exercising the pure builder:

1. data/ is present as a `--bind` (read-write) pair.
2. An external raw target (outside data/) appears as its own `--bind` pair.
3. A raw target nested inside data/ is omitted (no duplicate bind).
4. `rawTarget: null` omits the raw bind.
5. `~/.claude` and `~/.claude.json` appear as `--bind` pairs.
6. `--ro-bind / /` is present and precedes the writable binds (a repo path like
   `<repo>/src` is therefore read-only — assert it is NOT in any `--bind`).
7. `--chdir <dataDir>` and `--die-with-parent` are present.

No existing test touches `runAgent`; `npm test` + `npm run typecheck` must stay
green.

## Residual risk (accepted)

`~/.claude` and `~/.claude.json` stay writable because session resume and
credential refresh require it. A maximally-adversarial turn could tamper with
*global Claude state* (other projects' transcripts, the global
`~/.claude/CLAUDE.md`) — but **not** the icarus source, which was the goal.
Narrowing to `~/.claude/projects` + `.credentials.json` only is possible but
brittle as Claude's state layout shifts; deferred.

## Docs

- `CLAUDE.md` (codebase guide): note the agent runs under bwrap by default and
  document `AGENT_SANDBOX`.
- `.env.example`: add `AGENT_SANDBOX` with a one-line comment.
