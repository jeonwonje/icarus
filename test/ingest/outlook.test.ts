import { describe, expect, it } from 'vitest';
import { messageFileName, isBulkMessage } from '../../src/ingest/outlook.js';

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

describe('isBulkMessage', () => {
  it('flags List-Unsubscribe headers', () => {
    expect(isBulkMessage('List-Unsubscribe: <mailto:x@y.com>')).toBe(true);
  });
  it('flags Precedence: bulk/list/junk', () => {
    expect(isBulkMessage('Precedence: bulk')).toBe(true);
    expect(isBulkMessage('precedence:   list')).toBe(true);
  });
  it('flags Auto-Submitted: auto-generated', () => {
    expect(isBulkMessage('Auto-Submitted: auto-generated')).toBe(true);
  });
  it('returns false for ordinary mail and empty headers', () => {
    expect(isBulkMessage('From: a@b.com\nTo: c@d.com')).toBe(false);
    expect(isBulkMessage('')).toBe(false);
  });
});
