import { describe, it, expect } from 'vitest';

import { handleCanvas, handlePing, handleHelp } from '../src/admin-commands.js';

describe('handleCanvas', () => {
  it('reports "not configured" when no token is given', async () => {
    const res = await handleCanvas('');
    expect(res.handled).toBe(true);
    expect(res.reply).toMatch(/not configured/i);
  });
});

describe('basic admin commands', () => {
  it('ping replies pong', () => {
    expect(handlePing().reply).toBe('pong');
  });
  it('help lists /canvas', () => {
    expect(handleHelp().reply).toContain('/canvas');
  });
});
