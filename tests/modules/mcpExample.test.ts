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
