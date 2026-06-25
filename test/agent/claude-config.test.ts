import { afterEach, describe, expect, it, vi } from 'vitest';

describe('claude-config', () => {
  afterEach(() => vi.resetModules());

  it('default model is opus 4.8 1m, overridable', async () => {
    const c = await import('../../src/agent/claude-config.js');
    expect(c.getClaudeModel()).toBe('claude-opus-4-8[1m]');
    c.setClaudeModel('claude-sonnet-4-6');
    expect(c.getClaudeModel()).toBe('claude-sonnet-4-6');
    c.setClaudeModel(null);
    expect(c.getClaudeModel()).toBe('claude-opus-4-8[1m]');
  });

  it('buildQueryEnv sets ICARUS_HOME and preserves PATH', async () => {
    const c = await import('../../src/agent/claude-config.js');
    const env = c.buildQueryEnv();
    expect(env.ICARUS_HOME).toBeTruthy();
    expect(env.PATH || env.Path).toBeTruthy();
  });

  it('requireOAuthToken throws a clear error when unset', async () => {
    const saved = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const c = await import('../../src/agent/claude-config.js');
    expect(() => c.requireOAuthToken()).toThrow(/CLAUDE_CODE_OAUTH_TOKEN/);
    if (saved) process.env.CLAUDE_CODE_OAUTH_TOKEN = saved;
  });
});
