import { describe, expect, it } from 'vitest';
import { triageGray, parseVerdicts, type GrayItem } from '../../src/ingest/outlook-triage.js';

const items: GrayItem[] = [
  { id: 'g0', sender: 'a@x.com', subject: 'Webinar invite' },
  { id: 'g1', sender: 'b@y.com', subject: 'Your grade is posted' },
];

describe('parseVerdicts', () => {
  it('parses one verdict per line, case-insensitive', () => {
    const m = parseVerdicts('g0 junk\ng1 KEEP\n');
    expect(m.get('g0')).toBe('junk');
    expect(m.get('g1')).toBe('keep');
  });
  it('ignores blank and malformed lines', () => {
    const m = parseVerdicts('\ngarbage line\ng0   junk  extra\n');
    expect(m.get('g0')).toBe('junk');
    expect(m.size).toBe(1);
  });
});

describe('triageGray', () => {
  it('returns keep for every item when disabled', async () => {
    const r = await triageGray(items, { enabled: false });
    expect(r.get('g0')).toBe('keep');
    expect(r.get('g1')).toBe('keep');
  });
  it('applies junk verdicts from the classifier, defaulting the rest to keep', async () => {
    const classify = async (_b: GrayItem[]) => new Map([['g0', 'junk' as const]]);
    const r = await triageGray(items, { enabled: true, classify });
    expect(r.get('g0')).toBe('junk');
    expect(r.get('g1')).toBe('keep'); // not mentioned by classifier → keep
  });
  it('defaults the whole batch to keep when the classifier throws', async () => {
    const classify = async () => { throw new Error('sdk down'); };
    const r = await triageGray(items, { enabled: true, classify });
    expect(r.get('g0')).toBe('keep');
    expect(r.get('g1')).toBe('keep');
  });
  it('returns an empty map for no items', async () => {
    const r = await triageGray([], { enabled: true });
    expect(r.size).toBe(0);
  });
});
