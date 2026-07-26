import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { calendarConfig } from '../../src/modules/calendar/config.js';
import { browserConfig } from '../../src/modules/browser/config.js';

describe('calendar/browser config', () => {
  it('calendarConfig throws when env missing (non-selftest)', () => {
    const prev = process.env.ICARUS_CALENDAR_MCP;
    delete process.env.ICARUS_CALENDAR_MCP;
    try {
      assert.throws(() => calendarConfig({ selftest: false, raw: undefined }), /ICARUS_CALENDAR_MCP/);
    } finally {
      if (prev !== undefined) process.env.ICARUS_CALENDAR_MCP = prev;
    }
  });
  it('browserConfig throws when env missing (non-selftest)', () => {
    assert.throws(() => browserConfig({ selftest: false, raw: undefined }), /ICARUS_BROWSER_MCP/);
  });
  it('accepts valid JSON in non-selftest', () => {
    const c = calendarConfig({
      selftest: false,
      raw: JSON.stringify({ command: 'npx', args: ['-y', 'x'] }),
    });
    assert.equal(c.command, 'npx');
  });
});
