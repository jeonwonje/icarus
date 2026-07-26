import './env.js';

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canvasStatusLine, formatCanvasStatusLine } from '../src/connectors/canvas.js';

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

test('canvasStatusLine returns null when Canvas env unset', () => {
  assert.equal(canvasStatusLine(), null);
});
