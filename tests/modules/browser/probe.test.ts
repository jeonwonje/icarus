import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createLineReader, expandEnvRefs } from '../../../src/modules/browser/probe.js';

describe('expandEnvRefs', () => {
  it('expands a known variable', () => {
    assert.equal(expandEnvRefs('${APPDATA}\\npm', { APPDATA: 'C:\\x' }), 'C:\\x\\npm');
  });

  it('expands several variables in one string', () => {
    assert.equal(expandEnvRefs('${A}/${B}', { A: 'one', B: 'two' }), 'one/two');
  });

  it('leaves an unknown variable untouched rather than emitting undefined', () => {
    assert.equal(expandEnvRefs('${NOPE}/x', {}), '${NOPE}/x');
  });

  it('leaves a string with no references unchanged', () => {
    assert.equal(expandEnvRefs('node', {}), 'node');
  });
});

describe('createLineReader', () => {
  it('returns a message that arrives in one chunk', () => {
    const r = createLineReader();
    assert.deepEqual(r.push('{"id":1}\n'), [{ id: 1 }]);
  });

  it('reassembles a message split across chunks', () => {
    const r = createLineReader();
    assert.deepEqual(r.push('{"id":'), []);
    assert.deepEqual(r.push('1}\n'), [{ id: 1 }]);
  });

  it('returns both messages when two arrive in one chunk', () => {
    const r = createLineReader();
    assert.deepEqual(r.push('{"id":1}\n{"id":2}\n'), [{ id: 1 }, { id: 2 }]);
  });

  it('buffers a trailing partial line instead of losing it', () => {
    const r = createLineReader();
    assert.deepEqual(r.push('{"id":1}\n{"id":'), [{ id: 1 }]);
    assert.deepEqual(r.push('2}\n'), [{ id: 2 }]);
  });

  it('skips non-JSON banner lines without throwing', () => {
    const r = createLineReader();
    assert.deepEqual(r.push('starting up...\n{"id":1}\n'), [{ id: 1 }]);
  });
});
