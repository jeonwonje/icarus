import { describe, it, expect } from 'vitest';
import { sanitizeName, slug } from './sync.mjs';

describe('sanitizeName', () => {
  it('strips separators and control chars, never returns . or ..', () => {
    expect(sanitizeName('a/b\\c')).toBe('a_b_c');
    expect(sanitizeName('..')).toBe('file');
    expect(sanitizeName('  hi  ')).toBe('hi');
  });
});

describe('slug', () => {
  it('lowercases and dasherizes, caps length, falls back', () => {
    expect(slug('Fee Payment Deadline!')).toBe('fee-payment-deadline');
    expect(slug('   ')).toBe('untitled');
    expect(slug('a'.repeat(80)).length).toBeLessThanOrEqual(60);
  });
});
