import './env.js';

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTriageOutput } from '../src/connectors/telegram/triageOutput.js';

test('parses fenced JSON object', () => {
  const r = parseTriageOutput('```json\n{"digest":"","facts":[],"spill":[],"approvals":[]}\n```');
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.output.facts.length, 0);
});

test('empty JSON is silence', () => {
  const r = parseTriageOutput('{"digest":"","facts":[],"spill":[],"approvals":[]}');
  assert.equal(r.ok, true);
});

test('legacy prose becomes digest-only fallback', () => {
  const r = parseTriageOutput('▸ meeting · tomorrow 3pm');
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.output.digest, '▸ meeting · tomorrow 3pm');
    assert.equal(r.output.rawFallbackDigest, '▸ meeting · tomorrow 3pm');
  }
});

test('garbage fails', () => {
  const r = parseTriageOutput('{not json');
  assert.equal(r.ok, false);
});

test('unknown project slug kept but fact claim required', () => {
  const r = parseTriageOutput(
    JSON.stringify({
      digest: '',
      facts: [{ project: 'nope', claim: 'x', cite: [1] }],
      spill: [],
      approvals: [],
    }),
  );
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.output.facts[0]!.project, 'nope');
    assert.equal(r.output.facts[0]!.claim, 'x');
  }
});

test('empty string is silence', () => {
  const r = parseTriageOutput('');
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.output.digest, '');
    assert.equal(r.output.facts.length, 0);
  }
});
