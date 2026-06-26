import { describe, expect, it } from 'vitest';
import { messageFileName, isBulkMessage } from '../../src/ingest/outlook.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { injectFilteredLine, applyTriageVerdicts } from '../../src/ingest/outlook.js';

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

describe('injectFilteredLine', () => {
  it('inserts a Filtered line right after the Folder line', () => {
    const md = ['# Subj', '', '- **From:** a@b.com', '- **Date:** 2026-01-01', '- **Folder:** Inbox', '', '---', '', 'body', ''].join('\n');
    const out = injectFilteredLine(md, 'llm:junk');
    const lines = out.split('\n');
    const fi = lines.findIndex((l) => l.startsWith('- **Folder:**'));
    expect(lines[fi + 1]).toBe('- **Filtered:** llm:junk');
  });
  it('returns content unchanged when there is no Folder line', () => {
    expect(injectFilteredLine('no header here', 'llm:junk')).toBe('no header here');
  });
});

describe('applyTriageVerdicts', () => {
  it('moves keep→dest, junk→filtered (with Filtered line), and removes empty _graytriage', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-triage-'));
    const destDir = path.join(root, 'out');
    const filteredDir = path.join(root, 'out', '_filtered');
    const graytriageDir = path.join(root, 'out', '_graytriage');
    for (const d of [destDir, filteredDir, graytriageDir]) fs.mkdirSync(d, { recursive: true });

    const keepFile = path.join(graytriageDir, '2026-01-01_keep.md');
    const junkFile = path.join(graytriageDir, '2026-01-01_junk.md');
    const junkBody = ['# J', '', '- **Folder:** Inbox', '', '---', '', 'b', ''].join('\n');
    fs.writeFileSync(keepFile, 'keep-content');
    fs.writeFileSync(junkFile, junkBody);

    const gray = [
      { id: 'g0', sender: 'a@x.com', subject: 'keep', file: keepFile },
      { id: 'g1', sender: 'b@y.com', subject: 'junk', file: junkFile },
    ];
    const verdicts = new Map([['g0', 'keep' as const], ['g1', 'junk' as const]]);
    const counters = { kept: 0, filteredBlock: 0, filteredLlm: 0, gray: 0, attachments: 0, skipped: 0 };

    applyTriageVerdicts(gray, verdicts, { destDir, filteredDir, graytriageDir }, counters);

    expect(fs.existsSync(path.join(destDir, '2026-01-01_keep.md'))).toBe(true);
    expect(fs.readFileSync(path.join(filteredDir, '2026-01-01_junk.md'), 'utf-8')).toContain('- **Filtered:** llm:junk');
    expect(fs.existsSync(graytriageDir)).toBe(false); // emptied → removed
    expect(counters.kept).toBe(1);
    expect(counters.filteredLlm).toBe(1);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('defaults a missing verdict to keep', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-triage2-'));
    const destDir = path.join(root, 'out');
    const filteredDir = path.join(destDir, '_filtered');
    const graytriageDir = path.join(destDir, '_graytriage');
    for (const d of [destDir, filteredDir, graytriageDir]) fs.mkdirSync(d, { recursive: true });
    const f = path.join(graytriageDir, '2026-01-01_x.md');
    fs.writeFileSync(f, 'x');
    const counters = { kept: 0, filteredBlock: 0, filteredLlm: 0, gray: 0, attachments: 0, skipped: 0 };
    applyTriageVerdicts([{ id: 'g0', sender: 's', subject: 'x', file: f }], new Map(), { destDir, filteredDir, graytriageDir }, counters);
    expect(fs.existsSync(path.join(destDir, '2026-01-01_x.md'))).toBe(true);
    expect(counters.kept).toBe(1);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
