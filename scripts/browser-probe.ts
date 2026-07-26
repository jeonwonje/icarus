import { spawn } from 'node:child_process';
import { createLineReader, expandEnvRefs } from '../src/modules/browser/probe.js';
import { loadMcpServers, mcpJsonPath } from '../src/modules/mcpJsonFile.js';

const TIMEOUT_MS = 30_000;
const CLOSE_MS = 3_000;

type StdioEntry = { command: string; args?: string[]; env?: Record<string, string> };

function browserEntry(): StdioEntry {
  const servers = loadMcpServers();
  const entry = servers.browser as StdioEntry | undefined;
  if (!entry?.command) {
    throw new Error(`mcpServers.browser in ${mcpJsonPath()} is missing or is not a stdio entry`);
  }
  return entry;
}

/**
 * The native host accepts exactly ONE MCP client per host lifetime, on any transport — verified
 * against both the stdio bridge and a direct HTTP client, and its DELETE session verb answers 400.
 * Ending stdin cleanly does not release it. Every connection after the first gets this error.
 */
const WEDGED = 'Already connected to a transport';
const WEDGED_HINT =
  'the native host already has a client bound — it accepts only one per lifetime. Kill the node process listening on 127.0.0.1:12306; the extension relaunches it within seconds.';

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

  /** Ends stdin so the server closes its upstream session, then waits before forcing. */
  const shutdown = async (): Promise<void> => {
    done = true;
    child.stdin.end();
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => { child.kill(); resolve(); }, CLOSE_MS);
      child.once('exit', () => { clearTimeout(t); resolve(); });
    });
  };

  const fail = async (message: string): Promise<never> => {
    console.error(`FAIL: ${message}`);
    await shutdown();
    process.exit(1);
  };

  child.on('error', (e) => void fail(`could not spawn the browser server: ${e.message}`));
  child.on('exit', (code) => {
    if (done) return;
    void fail(`server exited with code ${code} before responding — the spawned path is likely wrong`);
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
      if (m.error) void fail(`server returned an error: ${m.error.message ?? 'unknown'}`);
      resolve(m.result);
    }
  });
  let stderrSeen = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderrSeen += chunk;
    console.error(`[server] ${chunk.trimEnd()}`);
  });

  let nextId = 1;
  const call = (method: string, params?: unknown): Promise<unknown> => {
    const id = nextId++;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  };

  const timer = setTimeout(
    () => void fail(`no response within ${TIMEOUT_MS}ms — is Chrome running with the extension connected?`),
    TIMEOUT_MS,
  );

  const init = (await call('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'icarus-browser-probe', version: '1' },
  })) as { serverInfo?: { name?: string; version?: string } };
  console.log(`connected: ${init.serverInfo?.name ?? '?'} v${init.serverInfo?.version ?? '?'}`);

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  // The bridge answers initialize and tools/list locally, so neither proves the extension is
  // attached. Only a tool call reaches the native host.
  const listed = (await call('tools/list')) as { tools: { name: string }[] };
  const names = listed.tools.map((t) => t.name);
  console.log(`tools (${names.length}): ${names.join(', ')}`);

  const tabsTool = names.find((n) => /windows_and_tabs/.test(n));
  if (!tabsTool) {
    await fail(`no tab-listing tool found among: ${names.join(', ')}`);
    return;
  }

  const tabs = (await call('tools/call', { name: tabsTool, arguments: {} })) as {
    content?: { type: string; text?: string }[];
    isError?: boolean;
  };
  clearTimeout(timer);

  const text = (tabs.content ?? []).map((c) => c.text ?? '').join('\n').trim();
  // The wedge surfaces on stderr, not in the tool result, so check both.
  if (`${text}\n${stderrSeen}`.includes(WEDGED)) {
    await fail(WEDGED_HINT);
    return;
  }
  if (tabs.isError || !text) {
    await fail(`${tabsTool} returned no usable content: ${text || '(empty)'}`);
    return;
  }

  let parsed: { tabCount?: number; windows?: unknown[] };
  try {
    parsed = JSON.parse(text) as { tabCount?: number; windows?: unknown[] };
  } catch {
    await fail(`${tabsTool} did not return JSON — server said: ${text.slice(0, 300)}`);
    return;
  }
  if (typeof parsed.tabCount !== 'number' || !Array.isArray(parsed.windows)) {
    await fail(`${tabsTool} returned an unrecognised payload: ${text.slice(0, 300)}`);
    return;
  }

  console.log('--- live tabs ---');
  console.log(text);
  console.log('--- end ---');
  console.log(`PASS: ${parsed.tabCount} tab(s) in ${parsed.windows.length} window(s) — check these are YOUR real tabs, not an empty throwaway profile.`);
  await shutdown();
  process.exitCode = 0;
}

void main();
