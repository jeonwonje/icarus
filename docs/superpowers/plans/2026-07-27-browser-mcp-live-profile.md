# Browser MCP on the Live Chrome Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `browser` MCP server with `mcp-chrome` over stdio so Icarus operates inside the owner's already-running Chrome profile, with a repeatable probe that proves it is attached to the real browser and not a throwaway one.

**Architecture:** No change to turn behaviour — `requireMcpServer('browser')` only asserts the key exists in Desktop `.mcp.json`, so the capability swap itself is configuration and documentation. The one code addition is verification tooling the spec's Verification section calls for: two pure helpers (`${VAR}` expansion and newline-delimited JSON-RPC framing) backing a `scripts/browser-probe.ts` CLI that spawns whatever `.mcp.json` declares and reports the owner's live tabs. Tests cover the helpers and guard the shipped example against silently reverting to a CDP-based server.

**Tech Stack:** TypeScript ESM, Node 24, tsx (no build step), `node:test` via `tsx --test`, `mcp-chrome` + `mcp-chrome-bridge` (Chrome extension + Native Messaging host).

## Global Constraints

- TypeScript ESM, Node 24, run via tsx — there is no build step.
- `npm run typecheck` must stay clean; `npm run selftest` must print ok.
- Tests live outside `src/`, under `tests/`, matched by the glob `tests/**/*.test.ts`.
- Commits are plain — no co-author trailers, no generated-with lines (a PreToolUse hook enforces this).
- Never commit `.env`, anything under `state/` / `archive/`, or anything from the Desktop data root. **Desktop `.mcp.json` is Desktop data — it is edited but never committed.**
- Transport for the browser server is **stdio**, not HTTP. This preserves the "local stdio server" wording in root `CLAUDE.md` and `src/modules/browser/README.md`, opens no listening port, and avoids the `"type": "streamableHttp"` vs `"type": "http"` spelling ambiguity between MCP clients.
- The owner's Chrome profile is never moved, copied, or recreated.
- No gate is added in front of browser actions. This is a deliberate owner decision recorded in the spec's Accepted Risks; do not add allowlists, denylists, or confirmation prompts.
- No MCP servers are added or removed beyond swapping the `browser` entry. The roster stays `calendar` + `browser`.
- `src/agent/guard.ts` is not touched. Keep it small, static, and reviewed.
- Spec: `docs/superpowers/specs/2026-07-27-browser-mcp-live-profile-design.md`.

## File map (target)

| Path | Responsibility |
|---|---|
| `src/modules/browser/probe.ts` | Create — two pure helpers: `expandEnvRefs` and `createLineReader` |
| `tests/modules/browser/probe.test.ts` | Create — framing and expansion tests |
| `scripts/browser-probe.ts` | Create — CLI: spawn the declared browser server, handshake, `tools/list`, list live tabs |
| `package.json` | Modify — add the `browser-probe` script |
| `docs/mcp.json.example` | Modify — `browser` entry becomes the `mcp-chrome` stdio bridge |
| `tests/modules/mcpExample.test.ts` | Create — guards the shipped example against drift back to CDP |
| `src/modules/browser/README.md` | Rewrite — `mcp-chrome` setup plus the Chrome 136 rationale |
| root `README.md` | Modify — the module config table's `browser` row must name `mcp-chrome`, not the removed server |
| Desktop `.mcp.json` | Owner-edited, outside the repo, never committed |

**Typecheck coverage — read before relying on it.** `tsconfig.json` sets `"include": ["src/**/*.ts"]`, so `npm run typecheck` covers `src/modules/browser/probe.ts` but **not** `scripts/browser-probe.ts` or anything under `tests/`. `scripts/tg-setup.ts` already sits outside coverage the same way, so this matches the codebase rather than introducing a gap; do not widen `tsconfig.json` for this change. Task 1 typechecks the script explicitly with a one-off `tsc` invocation instead.

**Why `expandEnvRefs` is needed and not speculative:** Claude Code expands `${VAR}` when *it* reads `.mcp.json`. `loadMcpServers()` in `src/modules/mcpJsonFile.ts` does raw `JSON.parse` and does no expansion. The probe reads the same file directly, so without expansion it would try to spawn a literal `${APPDATA}` path and fail confusingly.

**Why `createLineReader` is needed and not speculative:** a stdio MCP server emits newline-delimited JSON that arrives split across arbitrary chunk boundaries. `tools/list` in particular is a single very long line. Naive per-chunk parsing drops it, and the failure looks like "the server has no tools" rather than a framing bug.

---

### Task 1: Probe helpers and the `browser-probe` CLI

**Files:**
- Create: `src/modules/browser/probe.ts`
- Create: `tests/modules/browser/probe.test.ts`
- Create: `scripts/browser-probe.ts`
- Modify: `package.json` (scripts block)

**Interfaces:**
- Consumes: `loadMcpServers(filePath?: string): Record<string, unknown>` from `src/modules/mcpJsonFile.ts` (already exists).
- Produces:
  - `export function expandEnvRefs(value: string, env?: NodeJS.ProcessEnv): string`
  - `export interface LineReader { push(chunk: string): unknown[] }`
  - `export function createLineReader(): LineReader`

- [ ] **Step 1: Write the failing tests**

Create `tests/modules/browser/probe.test.ts`:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createLineReader, expandEnvRefs } from '../../../src/modules/browser/probe.js';

describe('expandEnvRefs', () => {
  it('expands a known variable', () => {
    assert.equal(expandEnvRefs('${APPDATA}\\npm', { APPDATA: 'C:\\x' }), 'C:\\x\\npm');
  });

  it('expands several variables in one string', () => {
    assert.equal(expandEnvRefs('${A}/${B}', { A: 'one', B: 'two' }), 'one/two');
  });

  it('leaves an unknown variable untouched rather than emitting undefined', () => {
    assert.equal(expandEnvRefs('${NOPE}/x', {}), '${NOPE}/x');
  });

  it('leaves a string with no references unchanged', () => {
    assert.equal(expandEnvRefs('node', {}), 'node');
  });
});

describe('createLineReader', () => {
  it('returns a message that arrives in one chunk', () => {
    const r = createLineReader();
    assert.deepEqual(r.push('{"id":1}\n'), [{ id: 1 }]);
  });

  it('reassembles a message split across chunks', () => {
    const r = createLineReader();
    assert.deepEqual(r.push('{"id":'), []);
    assert.deepEqual(r.push('1}\n'), [{ id: 1 }]);
  });

  it('returns both messages when two arrive in one chunk', () => {
    const r = createLineReader();
    assert.deepEqual(r.push('{"id":1}\n{"id":2}\n'), [{ id: 1 }, { id: 2 }]);
  });

  it('buffers a trailing partial line instead of losing it', () => {
    const r = createLineReader();
    assert.deepEqual(r.push('{"id":1}\n{"id":'), [{ id: 1 }]);
    assert.deepEqual(r.push('2}\n'), [{ id: 2 }]);
  });

  it('skips non-JSON banner lines without throwing', () => {
    const r = createLineReader();
    assert.deepEqual(r.push('starting up...\n{"id":1}\n'), [{ id: 1 }]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../../../src/modules/browser/probe.js'`

- [ ] **Step 3: Write the minimal implementation**

Create `src/modules/browser/probe.ts`:

```ts
/** Expands `${VAR}` references the way Claude Code does when it reads `.mcp.json`. */
export function expandEnvRefs(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) => env[name] ?? match);
}

export interface LineReader {
  /** Feeds a stdout chunk in; returns whatever complete JSON messages it completed. */
  push(chunk: string): unknown[];
}

/** Frames a stdio MCP stream into complete newline-delimited JSON messages. */
export function createLineReader(): LineReader {
  let buffered = '';
  return {
    push(chunk: string): unknown[] {
      buffered += chunk;
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      const messages: unknown[] = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          messages.push(JSON.parse(trimmed));
        } catch {
          // Servers print human-readable banners to stdout; they are not protocol errors.
        }
      }
      return messages;
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — all nine new assertions green, existing suites unaffected.

- [ ] **Step 5: Write the probe CLI**

Create `scripts/browser-probe.ts`. It deliberately reads the **real** Desktop `.mcp.json` rather than hardcoding a command, so it verifies the config the agent actually uses. It discovers the tab-listing tool by pattern rather than by a hardcoded name, because the server's tool prefix is confirmed only at runtime.

```ts
import { spawn } from 'node:child_process';
import { createLineReader, expandEnvRefs } from '../src/modules/browser/probe.js';
import { loadMcpServers, mcpJsonPath } from '../src/modules/mcpJsonFile.js';

const TIMEOUT_MS = 30_000;

type StdioEntry = { command: string; args?: string[]; env?: Record<string, string> };

function browserEntry(): StdioEntry {
  const servers = loadMcpServers();
  const entry = servers.browser as StdioEntry | undefined;
  if (!entry?.command) {
    throw new Error(`mcpServers.browser in ${mcpJsonPath()} is missing or is not a stdio entry`);
  }
  return entry;
}

async function main(): Promise<void> {
  const entry = browserEntry();
  const command = expandEnvRefs(entry.command);
  const args = (entry.args ?? []).map((a) => expandEnvRefs(a));
  const env = { ...process.env, ...Object.fromEntries(
    Object.entries(entry.env ?? {}).map(([k, v]) => [k, expandEnvRefs(v)]),
  ) };

  console.log(`spawning: ${command} ${args.join(' ')}`);
  const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let done = false;
  const fail = (message: string): never => {
    done = true;
    console.error(`FAIL: ${message}`);
    child.kill();
    process.exit(1);
  };
  child.on('error', (e) => fail(`could not spawn the browser server: ${e.message}`));
  child.on('exit', (code) => {
    if (done) return;
    fail(`server exited with code ${code} before responding — the spawned path is likely wrong`);
  });

  const reader = createLineReader();
  const pending = new Map<number, (result: unknown) => void>();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    for (const msg of reader.push(chunk)) {
      const m = msg as { id?: number; result?: unknown; error?: { message?: string } };
      if (typeof m.id !== 'number') continue;
      const resolve = pending.get(m.id);
      if (!resolve) continue;
      pending.delete(m.id);
      if (m.error) fail(`server returned an error: ${m.error.message ?? 'unknown'}`);
      resolve(m.result);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => console.error(`[server] ${chunk.trimEnd()}`));

  let nextId = 1;
  const call = (method: string, params?: unknown): Promise<unknown> => {
    const id = nextId++;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  };

  const timer = setTimeout(() => fail(`no response within ${TIMEOUT_MS}ms — is Chrome running with the extension connected?`), TIMEOUT_MS);

  const init = (await call('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'icarus-browser-probe', version: '1' },
  })) as { serverInfo?: { name?: string; version?: string } };
  console.log(`connected: ${init.serverInfo?.name ?? '?'} v${init.serverInfo?.version ?? '?'}`);

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  const listed = (await call('tools/list')) as { tools: { name: string }[] };
  const names = listed.tools.map((t) => t.name);
  console.log(`tools (${names.length}): ${names.join(', ')}`);

  const tabsTool = names.find((n) => /windows_and_tabs/.test(n));
  if (!tabsTool) fail(`no tab-listing tool found among: ${names.join(', ')}`);

  const tabs = (await call('tools/call', { name: tabsTool, arguments: {} })) as {
    content?: { type: string; text?: string }[];
  };
  clearTimeout(timer);
  console.log('--- live tabs ---');
  console.log(tabs.content?.map((c) => c.text ?? '').join('\n') ?? '(no content)');
  console.log('--- end ---');
  console.log('PASS: check the tabs above are YOUR real open tabs, not an empty throwaway profile.');
  done = true;
  child.kill();
  process.exitCode = 0;
}

void main();
```

- [ ] **Step 6: Register the npm script**

In `package.json`, add to `scripts`, directly after `"selftest"`:

```json
"browser-probe": "tsx scripts/browser-probe.ts",
```

- [ ] **Step 7: Verify typecheck stays clean**

Run: `npm run typecheck`
Expected: PASS, no output. This covers `src/modules/browser/probe.ts` only.

- [ ] **Step 8: Typecheck the script, which the project config does not cover**

`tsconfig.json` includes `src/**/*.ts` only, and tsx strips types without checking them, so a
type error in `scripts/browser-probe.ts` would otherwise surface for the first time during
Task 3's live run. Check it directly:

Run: `npx tsc --noEmit --strict --skipLibCheck --target es2023 --module esnext --moduleResolution bundler --types node scripts/browser-probe.ts`
Expected: PASS, no output.

Do not widen `tsconfig.json` to fix this. `scripts/tg-setup.ts` already sits outside coverage
the same way; changing the project config is out of scope for this plan.

The probe itself is not run yet — Desktop `.mcp.json` still declares `chrome-devtools-mcp` at this point, and `mcp-chrome-bridge` is not installed. Running it now would spawn a fresh throwaway Chrome. Task 3 runs it.

- [ ] **Step 9: Commit**

```bash
git add src/modules/browser/probe.ts tests/modules/browser/probe.test.ts scripts/browser-probe.ts package.json
git commit -m "Add a stdio probe for the browser MCP server."
```

---

### Task 2: Point the shipped example and module docs at mcp-chrome

**Files:**
- Modify: `docs/mcp.json.example`
- Create: `tests/modules/mcpExample.test.ts`
- Rewrite: `src/modules/browser/README.md`

**Interfaces:**
- Consumes: `loadMcpServers`, `calendarConfig`, `browserConfig` — all already exist and are already exercised by `tests/modules/calendar-browser.test.ts`.
- Produces: nothing consumed by later tasks. Task 3 copies the `browser` entry from `docs/mcp.json.example` into Desktop `.mcp.json` by hand.

- [ ] **Step 1: Write the failing test**

Create `tests/modules/mcpExample.test.ts`. It asserts the shipped example is valid *and* that it has not drifted back to a CDP-based server — the specific regression this whole change exists to prevent.

```ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { browserConfig } from '../../src/modules/browser/config.js';
import { calendarConfig } from '../../src/modules/calendar/config.js';
import { loadMcpServers } from '../../src/modules/mcpJsonFile.js';

const EXAMPLE = path.join(import.meta.dirname, '..', '..', 'docs', 'mcp.json.example');

describe('docs/mcp.json.example', () => {
  it('satisfies both required module config checks', () => {
    assert.doesNotThrow(() => calendarConfig({ selftest: false, filePath: EXAMPLE }));
    assert.doesNotThrow(() => browserConfig({ selftest: false, filePath: EXAMPLE }));
  });

  it('declares the browser server as the mcp-chrome stdio bridge', () => {
    const browser = loadMcpServers(EXAMPLE).browser as { command: string; args: string[] };
    assert.equal(browser.command, 'node');
    assert.equal(browser.args.length, 1);
    assert.match(browser.args[0], /mcp-chrome-bridge[\\/]dist[\\/]mcp[\\/]mcp-server-stdio\.js$/);
  });

  it('does not reference any CDP-based server', () => {
    // Chrome >= 136 ignores --remote-debugging-port on the default user-data-dir,
    // so no CDP server can ever reach the owner's real profile. See the spec.
    const raw = readFileSync(EXAMPLE, 'utf8');
    assert.doesNotMatch(raw, /chrome-devtools-mcp|playwright|puppeteer/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — the browser entry is still `{"command":"npx","args":["-y","chrome-devtools-mcp@latest"]}`, so `browser.command` is `npx`, not `node`, and the CDP assertion trips too.

- [ ] **Step 3: Update the example**

Replace the `browser` entry in `docs/mcp.json.example`. Leave `calendar` exactly as it is. The `${APPDATA}` reference matches the `${USERPROFILE}` style already used by `calendar`, and resolves to the machine's `npm root -g`, which is `C:\Users\jeon\AppData\Roaming\npm\node_modules`.

```json
{
  "mcpServers": {
    "calendar": {
      "command": "npx",
      "args": ["-y", "@cocal/google-calendar-mcp"],
      "env": {
        "GOOGLE_OAUTH_CREDENTIALS": "${USERPROFILE}\\Desktop\\icarus\\state\\gcp-oauth.keys.json",
        "GOOGLE_CALENDAR_MCP_TOKEN_PATH": "${USERPROFILE}\\Desktop\\icarus\\state\\gcp-calendar-token.json"
      }
    },
    "browser": {
      "command": "node",
      "args": ["${APPDATA}\\npm\\node_modules\\mcp-chrome-bridge\\dist\\mcp\\mcp-server-stdio.js"]
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS. Note `tests/modules/calendar-browser.test.ts` also stays green — it builds its own fixtures in a temp dir and never reads the shipped example.

- [ ] **Step 5: Rewrite the browser module README**

Replace the whole of `src/modules/browser/README.md` with:

````markdown
# browser module

Requires `mcpServers.browser` in Desktop `.mcp.json` (Claude project MCP). Loaded by the
Agent SDK on every turn (same as other `.mcp.json` servers). Icarus does not inject it.

Use [`mcp-chrome`](https://github.com/hangwin/mcp-chrome) — a Chrome extension plus a local
Native Messaging host. It runs **inside the owner's already-running Chrome**, so it uses the
real profile's cookies, sessions, and extensions.

## Why not chrome-devtools-mcp

Since **Chrome 136**, `--remote-debugging-port` and `--remote-debugging-pipe` are ignored
unless paired with a `--user-data-dir` pointing somewhere other than the default directory —
deliberate hardening against malware draining cookies over CDP, with no flag to re-enable it
(<https://developer.chrome.com/blog/remote-debugging-port>).

So **no CDP-based server can ever reach the owner's real profile**: not
`chrome-devtools-mcp`, not Playwright MCP, not Puppeteer. Left unflagged, they silently
launch a throwaway profile with no logins. Do not "fix" this module back to one.

Claude in Chrome is not an option either: it is absent from headless sessions, its Native
Messaging manifest pins `allowed_origins` to Anthropic's extension IDs, and its site
permissions are granted by clicking in the extension UI.

## Setup

Run by the owner in a normal terminal — never through Claude.

1. `npm i -g mcp-chrome-bridge`
2. `mcp-chrome-bridge register` — only if automatic registration does not fire. It writes an
   `HKCU\Software\Google\Chrome\NativeMessagingHosts` entry.
3. Load the `mcp-chrome` extension in Chrome (`chrome://extensions` → Developer mode → Load
   unpacked, or the Web Store listing).
4. **Enable auto-connect in the extension popup.** Without it the extension attaches only
   when clicked, which a headless agent cannot do. This is the step most likely to be missed.
5. Copy the `browser` entry from [`docs/mcp.json.example`](../../../docs/mcp.json.example)
   into Desktop `.mcp.json`.
6. `npm run browser-probe` — confirms the server answers and prints the owner's live tabs.
   Empty or unfamiliar tabs mean the extension is not attached.
7. `/restart` Icarus.

Transport is **stdio**, not the server's HTTP endpoint: it opens no listening port and avoids
the `"type": "streamableHttp"` / `"type": "http"` spelling difference between MCP clients.

Missing `mcpServers.browser` fails boot. Chrome being closed, the extension being
disconnected, or auto-connect being switched off after an extension update do **not** fail
boot — turns simply lack browser tools. Report that plainly; do not retry-loop.

## Risk

Browser actions are ungated. `src/agent/guard.ts` matches only
`Write|Edit|MultiEdit|NotebookEdit|Bash` and cannot see MCP tool calls, so form fills and
submissions run unattended under `bypassPermissions`, as the owner. This is a deliberate
decision recorded in `docs/superpowers/specs/2026-07-27-browser-mcp-live-profile-design.md`.

## Selftest

`--selftest` skips the Desktop file check.
````

- [ ] **Step 6: Verify the suite and typecheck**

Run: `npm test && npm run typecheck && npm run selftest`
Expected: tests PASS, typecheck silent, selftest prints ok.

- [ ] **Step 7: Commit**

```bash
git add docs/mcp.json.example tests/modules/mcpExample.test.ts src/modules/browser/README.md
git commit -m "Point the browser module at mcp-chrome over stdio."
```

---

### Task 3: Owner setup and live verification

**Files:**
- Modify: Desktop `C:\Users\jeon\Desktop\.mcp.json` — **outside the repo, never committed**
- Delete: `C:\Users\jeon\.cache\chrome-devtools-mcp\` — dead directory, outside the repo

**Interfaces:**
- Consumes: `npm run browser-probe` from Task 1; the `browser` entry from `docs/mcp.json.example` in Task 2.
- Produces: a working browser capability. Nothing downstream in code.

**This task is mostly the owner's to run, not the agent's.** Steps 1–4 install software and load a browser extension on the owner's live machine; an agent must not perform them unattended. The agent's part is steps 5–8: making the config edit, running the probe, and reporting honestly.

- [ ] **Step 1 (owner): Install the bridge**

```powershell
npm i -g mcp-chrome-bridge
```

- [ ] **Step 2 (owner): Confirm the native host registered**

```powershell
Get-ChildItem 'HKCU:\Software\Google\Chrome\NativeMessagingHosts' | Select-Object PSChildName
```

Expected: a `com.chromemcp.nativehost` entry alongside the existing
`com.anthropic.claude_code_browser_extension`. If it is absent, run `mcp-chrome-bridge register`
and check again.

- [ ] **Step 3 (owner): Confirm the installed bridge path matches the config**

```powershell
Test-Path "$env:APPDATA\npm\node_modules\mcp-chrome-bridge\dist\mcp\mcp-server-stdio.js"
```

Expected: `True`. If `False`, locate the real file and use that path in step 5 instead —
the `dist` layout is the one value in this plan taken from the package's documentation rather
than verified on this machine.

```powershell
Get-ChildItem "$env:APPDATA\npm\node_modules\mcp-chrome-bridge" -Recurse -Filter 'mcp-server-stdio.js' | Select-Object FullName
```

- [ ] **Step 4 (owner): Load the extension and enable auto-connect**

`chrome://extensions` → Developer mode → Load unpacked → select the `mcp-chrome` extension
folder (or install the Web Store listing). Open its popup and **turn auto-connect on**.

- [ ] **Step 5: Swap the Desktop config**

Edit `C:\Users\jeon\Desktop\.mcp.json`. Replace only the `browser` entry with the one from
`docs/mcp.json.example`; leave `calendar` byte-for-byte unchanged.

```json
"browser": {
  "command": "node",
  "args": ["${APPDATA}\\npm\\node_modules\\mcp-chrome-bridge\\dist\\mcp\\mcp-server-stdio.js"]
}
```

Do not `git add` this file. It is Desktop data.

- [ ] **Step 6: Run the probe**

Run: `npm run browser-probe`
Expected: `connected: …`, a tool list including a `windows_and_tabs` tool, then the owner's
**real** open tabs.

A tool list that arrives but shows an empty or unfamiliar tab set means the extension is not
attached — go back to step 4 and check auto-connect. An early exit (the process ending
before any response, reported with its exit code) means the path from step 3 is wrong. A
timeout means Chrome is not running.

- [ ] **Step 7: Confirm boot is unaffected**

Run: `npm run typecheck && npm run selftest && npm test`
Expected: typecheck silent, selftest prints ok, tests PASS.

- [ ] **Step 8: Remove the dead CDP cache directory**

```powershell
Remove-Item -Recurse -Force "$env:USERPROFILE\.cache\chrome-devtools-mcp" -ErrorAction SilentlyContinue
```

- [ ] **Step 9 (owner): Restart and confirm end-to-end**

`/restart` in the DM, then ask Icarus to read a page that requires the owner's login. A page
that renders as a login screen means the same failure as step 6.

- [ ] **Step 10: Commit**

Nothing from this task is committable — the config lives on the Desktop and the cache
directory is outside the repo. Record the outcome in the DM instead. If step 3 produced a
different bridge path, that **is** committable: update `docs/mcp.json.example` and the
regex in `tests/modules/mcpExample.test.ts` to match, then:

```bash
git add docs/mcp.json.example tests/modules/mcpExample.test.ts
git commit -m "Correct the mcp-chrome bridge path to the installed layout."
```

---

## Out of scope, deliberately

Recorded so a reviewer does not read these as omissions:

- **The consent-screen check.** The spec notes the Google OAuth consent screen must be
  published to production or the calendar refresh token expires every seven days. That is a
  GCP console action by the owner, with nothing to implement here.
- **Any gate on browser actions.** The owner chose none. See Global Constraints.
- **Any change to `src/modules/browser/{config,index}.ts` or the registry.** The existing
  `requireMcpServer('browser')` check is correct for the new server as written.
