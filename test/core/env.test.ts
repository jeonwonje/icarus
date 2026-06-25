import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readEnvFile } from '../../src/core/env.js';

describe('readEnvFile', () => {
  let dir: string;
  let cwd: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-env-'));
    cwd = process.cwd();
    process.chdir(dir);
  });
  afterEach(() => {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads requested keys, ignores comments, strips quotes', () => {
    fs.writeFileSync(
      path.join(dir, '.env'),
      '# a comment\nFOO=bar\nQUOTED="hello world"\nIGNORED=nope\n',
    );
    const out = readEnvFile(['FOO', 'QUOTED']);
    expect(out).toEqual({ FOO: 'bar', QUOTED: 'hello world' });
  });

  it('returns {} when .env is absent', () => {
    expect(readEnvFile(['FOO'])).toEqual({});
  });
});
