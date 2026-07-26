import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canvasConfig } from '../../../src/modules/canvas/config.js';

describe('canvas config', () => {
  it('throws when base URL missing (non-selftest)', () => {
    assert.throws(
      () => canvasConfig({ selftest: false, baseUrl: undefined, token: 'tok' }),
      /CANVAS_BASE_URL/,
    );
  });

  it('throws when token missing (non-selftest)', () => {
    assert.throws(
      () => canvasConfig({ selftest: false, baseUrl: 'https://school.instructure.com', token: undefined }),
      /CANVAS_API_TOKEN/,
    );
  });

  it('accepts valid env in non-selftest', () => {
    const c = canvasConfig({
      selftest: false,
      baseUrl: 'https://school.instructure.com/',
      token: 'abc123',
    });
    assert.equal(c.baseUrl, 'https://school.instructure.com');
    assert.equal(c.token, 'abc123');
  });

  it('selftest returns stub values', () => {
    const c = canvasConfig({ selftest: true });
    assert.equal(c.baseUrl, 'https://selftest.instructure.com');
    assert.equal(c.token, 'selftest');
  });
});
