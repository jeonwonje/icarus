import '../../env.js';

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from '../../../src/db.js';
import { canvasConfig } from '../../../src/modules/canvas/config.js';
import { canvasStatusLine, formatCanvasStatusLine } from '../../../src/modules/canvas/canvas.js';

openDb();

test('formatCanvasStatusLine strips scheme/trailing slash and slices timestamps', () => {
  assert.equal(
    formatCanvasStatusLine({
      baseUrl: 'https://school.instructure.com/',
      status: 'ok',
      pollAt: '2026-07-26T08:00:00.000Z',
      digestAt: '2026-07-26T08:05:12.000Z',
    }),
    '▸ canvas · school.instructure.com · poll ok 2026-07-26T08:00 · digest 2026-07-26T08:05',
  );
});

test('formatCanvasStatusLine uses never when timestamps missing', () => {
  assert.equal(
    formatCanvasStatusLine({
      baseUrl: 'https://school.instructure.com',
      status: 'never',
      pollAt: undefined,
      digestAt: undefined,
    }),
    '▸ canvas · school.instructure.com · poll never never · digest never',
  );
});

test('canvasStatusLine returns formatted line after config init', () => {
  canvasConfig({ selftest: true });
  const line = canvasStatusLine();
  assert.ok(line);
  assert.match(line!, /selftest\.instructure\.com/);
});
