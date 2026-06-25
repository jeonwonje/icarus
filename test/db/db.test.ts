import { afterEach, describe, expect, it } from 'vitest';
import { openDb, closeDb, getSession, setSession, clearSession } from '../../src/db/db.js';

describe('session store', () => {
  afterEach(() => closeDb());

  it('round-trips a session id per channel', () => {
    openDb(':memory:');
    expect(getSession('personal')).toBeNull();
    setSession('personal', 'sess-1');
    setSession('work', 'sess-2');
    expect(getSession('personal')).toBe('sess-1');
    expect(getSession('work')).toBe('sess-2');
  });

  it('upserts and clears', () => {
    openDb(':memory:');
    setSession('academic', 'a');
    setSession('academic', 'b');
    expect(getSession('academic')).toBe('b');
    clearSession('academic');
    expect(getSession('academic')).toBeNull();
  });
});
