import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { calendarConfig } from '../../src/modules/calendar/config.js';
import { browserConfig } from '../../src/modules/browser/config.js';
import { loadMcpServers, requireMcpServer } from '../../src/modules/mcpJsonFile.js';

describe('calendar/browser Desktop .mcp.json', () => {
  it('requireMcpServer skips file in selftest', () => {
    assert.doesNotThrow(() => requireMcpServer('calendar', { selftest: true }));
    assert.doesNotThrow(() => calendarConfig({ selftest: true }));
    assert.doesNotThrow(() => browserConfig({ selftest: true }));
  });

  it('throws when Desktop .mcp.json is missing', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'icarus-mcp-'));
    const filePath = path.join(dir, '.mcp.json');
    try {
      assert.throws(() => loadMcpServers(filePath), /Desktop \.mcp\.json is required/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws when mcpServers.calendar is missing', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'icarus-mcp-'));
    const filePath = path.join(dir, '.mcp.json');
    writeFileSync(filePath, JSON.stringify({ mcpServers: { browser: { command: 'npx' } } }));
    try {
      assert.throws(() => calendarConfig({ selftest: false, filePath }), /mcpServers\.calendar/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts calendar + browser entries', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'icarus-mcp-'));
    const filePath = path.join(dir, '.mcp.json');
    writeFileSync(
      filePath,
      JSON.stringify({
        mcpServers: {
          calendar: { command: 'npx', args: ['-y', '@cocal/google-calendar-mcp'] },
          browser: { command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest'] },
        },
      }),
    );
    try {
      assert.doesNotThrow(() => calendarConfig({ selftest: false, filePath }));
      assert.doesNotThrow(() => browserConfig({ selftest: false, filePath }));
      const servers = loadMcpServers(filePath);
      assert.equal((servers.calendar as { command: string }).command, 'npx');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
