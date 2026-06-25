import { describe, expect, it } from 'vitest';
import { messageFileName } from '../../src/ingest/outlook.js';

describe('messageFileName', () => {
  it('produces a date-prefixed safe slug', () => {
    const name = messageFileName('Re: Project!! Update', '2026-06-25T10:00:00Z');
    expect(name.startsWith('2026-06-25_')).toBe(true);
    expect(name.endsWith('.md')).toBe(true);
    expect(name).not.toMatch(/[^A-Za-z0-9._-]/);
  });

  it('falls back to "no-subject" for empty subjects', () => {
    expect(messageFileName('', '2026-06-25T10:00:00Z')).toContain('no-subject');
  });

  it('uses "undated_" prefix for empty date', () => {
    const name = messageFileName('Subject', '');
    expect(name.startsWith('undated_')).toBe(true);
    expect(name.endsWith('.md')).toBe(true);
    expect(name).not.toMatch(/[^A-Za-z0-9._-]/);
  });
});
