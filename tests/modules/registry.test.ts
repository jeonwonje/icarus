import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createModuleHost, mcpServersForTurn } from '../../src/modules/host.js';
import { registerAll, type Module } from '../../src/modules/registry.js';

describe('module registry', () => {
  it('registerAll invokes each module once in order', async () => {
    const seen: string[] = [];
    const mods: Module[] = [
      { id: 'a', register: () => { seen.push('a'); } },
      { id: 'b', register: async () => { seen.push('b'); } },
    ];
    const host = createModuleHost();
    await registerAll(host, mods);
    assert.deepEqual(seen, ['a', 'b']);
  });

  it('registerAll wraps errors with module id', async () => {
    const host = createModuleHost();
    await assert.rejects(
      () =>
        registerAll(host, [
          {
            id: 'broken',
            register: () => {
              throw new Error('missing FOO');
            },
          },
        ]),
      /module broken: missing FOO/,
    );
  });

  it('mcpServersForTurn respects when predicates', () => {
    const host = createModuleHost();
    host.addMcp('calendar', { type: 'stdio', command: 'cal' });
    host.addMcp('browser', { type: 'stdio', command: 'br' }, { when: (j) => !!j.browser });
    const all = mcpServersForTurn(host, { jid: 'x', kind: 'chat', browser: false });
    assert.equal(Object.keys(all).sort().join(','), 'calendar');
    const withBr = mcpServersForTurn(host, { jid: 'x', kind: 'job', browser: true });
    assert.equal(Object.keys(withBr).sort().join(','), 'browser,calendar');
  });
});
