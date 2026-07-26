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
  const fail = (message: string): never => {
    console.error(`FAIL: ${message}`);
    child.kill();
    process.exit(1);
  };
  child.on('error', (e) => fail(`could not spawn the browser server: ${e.message}`));

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
  child.kill();
  process.exit(0);
}

void main();
