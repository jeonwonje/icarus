import { describe, expect, it } from 'vitest';
import path from 'path';
import * as config from '../../src/core/config.js';

describe('config', () => {
  it('exposes the three channel ids as a record', () => {
    expect(config.CHANNELS).toHaveProperty('personal');
    expect(config.CHANNELS).toHaveProperty('academic');
    expect(config.CHANNELS).toHaveProperty('work');
  });

  it('HUB_DIR is absolute and defaults under the project root', () => {
    expect(path.isAbsolute(config.HUB_DIR)).toBe(true);
  });

  it('DB_PATH lives under STATE_DIR', () => {
    expect(config.DB_PATH.startsWith(config.STATE_DIR)).toBe(true);
  });

  it('agent timeouts are positive numbers', () => {
    expect(config.AGENT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(config.AGENT_IDLE_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
