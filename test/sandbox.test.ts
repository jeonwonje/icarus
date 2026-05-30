import path from 'path';

import { describe, it, expect } from 'vitest';

import { buildSandboxArgs } from '../src/sandbox.js';

const DATA = '/home/jeon/icarus/data';
const HOME = '/home/jeon';

// Find the value following the first matching flag occurrence.
function bindPairs(args: string[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--bind') pairs.push([args[i + 1], args[i + 2]]);
  }
  return pairs;
}

describe('buildSandboxArgs', () => {
  it('mounts the whole fs read-only before any writable bind', () => {
    const a = buildSandboxArgs({ dataDir: DATA, rawTarget: null, home: HOME });
    const ro = a.indexOf('--ro-bind');
    expect(ro).toBeGreaterThanOrEqual(0);
    expect(a[ro + 1]).toBe('/');
    expect(a[ro + 2]).toBe('/');
    expect(a.indexOf('--bind')).toBeGreaterThan(ro);
  });

  it('binds data/ read-write', () => {
    const a = buildSandboxArgs({ dataDir: DATA, rawTarget: null, home: HOME });
    expect(bindPairs(a)).toContainEqual([DATA, DATA]);
  });

  it('binds an external raw target read-write', () => {
    const raw = '/mnt/c/Users/jeonw/Desktop/icarus-raw';
    const a = buildSandboxArgs({ dataDir: DATA, rawTarget: raw, home: HOME });
    expect(bindPairs(a)).toContainEqual([raw, raw]);
  });

  it('omits a raw target nested inside data/', () => {
    const raw = path.join(DATA, 'raw');
    const a = buildSandboxArgs({ dataDir: DATA, rawTarget: raw, home: HOME });
    expect(bindPairs(a)).not.toContainEqual([raw, raw]);
  });

  it('omits the raw bind when rawTarget is null', () => {
    const a = buildSandboxArgs({ dataDir: DATA, rawTarget: null, home: HOME });
    const raws = bindPairs(a).filter(([s]) => s.includes('raw'));
    expect(raws).toEqual([]);
  });

  it('binds ~/.claude and ~/.claude.json read-write', () => {
    const a = buildSandboxArgs({ dataDir: DATA, rawTarget: null, home: HOME });
    const pairs = bindPairs(a);
    expect(pairs).toContainEqual([path.join(HOME, '.claude'), path.join(HOME, '.claude')]);
    expect(pairs).toContainEqual([path.join(HOME, '.claude.json'), path.join(HOME, '.claude.json')]);
  });

  it('never makes the source tree writable', () => {
    const a = buildSandboxArgs({ dataDir: DATA, rawTarget: null, home: HOME });
    const src = '/home/jeon/icarus/src';
    expect(bindPairs(a).some(([s]) => s === src)).toBe(false);
  });

  it('chdirs into data/ and dies with parent', () => {
    const a = buildSandboxArgs({ dataDir: DATA, rawTarget: null, home: HOME });
    const chdir = a.indexOf('--chdir');
    expect(chdir).toBeGreaterThanOrEqual(0);
    expect(a[chdir + 1]).toBe(DATA);
    expect(a).toContain('--die-with-parent');
  });
});
