/**
 * Patches the installed mcp-chrome native host so it stops handing every MCP client the same
 * cached Server instance.
 *
 * Upstream `getMcpServer()` caches one `Server` for the host's lifetime, so the SECOND client to
 * connect gets HTTP 500 "Already connected to a transport" — and never recovers until the host
 * restarts. For Icarus that means browser tools work on the first turn and fail on every turn
 * after it. Measured, not assumed: turn 1 returned a tab count, turns 2 and 3 both errored.
 *
 * Upstream bug: https://github.com/hangwin/mcp-chrome/issues/321 (open)
 * Open upstream PRs with this same fix: #295, #301, #338, #354 — none merged; last push to the
 * repo was 2026-01-06, and v1.0.0 is still the newest release.
 *
 * Both `connect()` call sites in dist/server/index.js already build a per-request transport and
 * track it in `transportsMap` with an `onclose` handler, so a per-connection Server is safe.
 *
 * Re-run this after any `npm i -g mcp-chrome-bridge`, which overwrites dist/. Idempotent.
 *
 *   node scripts/patch-mcp-chrome.mjs [--check]
 *
 * Exit codes: 0 patched or already patched (with --check: 0 = patched), 1 = failed / not patched.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const MARKER = 'PATCHED (icarus)';

const target = path.join(
  process.env.APPDATA ?? '',
  'npm',
  'node_modules',
  'mcp-chrome-bridge',
  'dist',
  'mcp',
  'mcp-server.js',
);

const checkOnly = process.argv.includes('--check');

if (!existsSync(target)) {
  console.error(`FAIL: mcp-chrome-bridge not found at ${target}`);
  console.error('Install it first: npm i -g mcp-chrome-bridge --ignore-scripts');
  process.exit(1);
}

const original = readFileSync(target, 'utf8');

if (original.includes(MARKER)) {
  console.log(`already patched: ${target}`);
  process.exit(0);
}

if (checkOnly) {
  console.error(`NOT PATCHED: ${target}`);
  process.exit(1);
}

// Match the upstream singleton body exactly, tolerating CRLF, so an upstream rewrite fails loudly
// rather than being silently mangled.
const SINGLETON =
  /const getMcpServer = \(\) => \{\s*if \(exports\.mcpServer\) \{\s*return exports\.mcpServer;\s*\}\s*exports\.mcpServer = new index_js_1\.Server\(([\s\S]*?)\);\s*\(0, register_tools_1\.setupTools\)\(exports\.mcpServer\);\s*return exports\.mcpServer;\s*\};/;

const match = original.match(SINGLETON);
if (!match) {
  console.error(`FAIL: getMcpServer() in ${target} does not match the known upstream shape.`);
  console.error('The package changed — re-read it and check whether the singleton bug is fixed.');
  process.exit(1);
}

const replacement = `const getMcpServer = () => {
    // ${MARKER}: upstream cached one Server for the host's lifetime, so the second client to
    // connect got "Already connected to a transport". See hangwin/mcp-chrome#321.
    const server = new index_js_1.Server(${match[1]});
    (0, register_tools_1.setupTools)(server);
    exports.mcpServer = server;
    return server;
};`;

writeFileSync(target, original.replace(SINGLETON, replacement));
console.log(`patched: ${target}`);
console.log('Restart the native host for it to take effect: kill the node process listening on 127.0.0.1:12306.');
