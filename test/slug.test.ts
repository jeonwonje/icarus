import { describe, expect, it } from 'vitest';

import { sanitizeFileName } from '../src/slug.js';

describe('sanitizeFileName', () => {
  it('strips path separators', () => {
    expect(sanitizeFileName('a/b/c.pdf')).toBe('a_b_c.pdf');
    expect(sanitizeFileName('a\\b.pdf')).toBe('a_b.pdf');
  });

  it('neutralizes parent-dir traversal', () => {
    // `/` → `_`, then `..` → `_`, leaving no path separators or traversal sequences.
    expect(sanitizeFileName('../../etc')).toBe('____etc');
  });

  it('falls back to "file" when empty after sanitization', () => {
    expect(sanitizeFileName('')).toBe('file');
    expect(sanitizeFileName('.')).toBe('file');
  });
});
