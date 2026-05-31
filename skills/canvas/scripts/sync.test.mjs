import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  parseNextLink,
  sanitizeName,
  courseDirName,
  courseAllowed,
  needsDownload,
  htmlToText,
  announcementSlug,
  renderAnnouncement,
  listActiveCourses,
  listCourseFiles,
  listCourseAnnouncements,
  syncCanvas,
  resolveHubDir,
} from './sync.mjs';

function jsonResponse(body, link) {
  return {
    ok: true,
    status: 200,
    headers: { get: (k) => (k.toLowerCase() === 'link' ? link : null) },
    json: async () => body,
  };
}

describe('sanitizeName', () => {
  it('replaces separators, rejects dot-names, trims', () => {
    expect(sanitizeName('a/b\\c')).toBe('a_b_c');
    expect(sanitizeName('..')).toBe('file');
    expect(sanitizeName('  x.pdf ')).toBe('x.pdf');
    expect(sanitizeName('')).toBe('file');
  });
});

describe('courseDirName', () => {
  it('lowercases the sanitized course code', () => {
    expect(courseDirName({ id: 1, course_code: 'ME2112' })).toBe('me2112');
    expect(courseDirName({ id: 1, course_code: 'THE1001_RC' })).toBe('the1001_rc');
    expect(courseDirName({ id: 7 })).toBe('course-7');
  });
});

describe('parseNextLink', () => {
  it('extracts rel=next or null', () => {
    expect(parseNextLink('<u1>; rel="current",<u2>; rel="next"')).toBe('u2');
    expect(parseNextLink('<u1>; rel="current"')).toBeNull();
    expect(parseNextLink(null)).toBeNull();
  });
});

describe('courseAllowed', () => {
  it('honors the allowlist', () => {
    const c = { id: 5, course_code: 'CDE2310' };
    expect(courseAllowed(c, '')).toBe(true);
    expect(courseAllowed(c, 'CDE2310')).toBe(true);
    expect(courseAllowed(c, 'X;5')).toBe(true);
    expect(courseAllowed(c, 'Y')).toBe(false);
  });
});

describe('needsDownload', () => {
  it('true unless present and unchanged', () => {
    expect(needsDownload({ updated_at: 't' }, undefined, true)).toBe(true);
    expect(needsDownload({ updated_at: 't' }, { updated_at: 't', path: 'p' }, false)).toBe(true);
    expect(needsDownload({ updated_at: 't' }, { updated_at: 'old', path: 'p' }, true)).toBe(true);
    expect(needsDownload({ updated_at: 't' }, { updated_at: 't', path: 'p' }, true)).toBe(false);
  });
});

describe('htmlToText', () => {
  it('strips tags, decodes entities, collapses', () => {
    const out = htmlToText('<p>Hi&nbsp;there</p><br><div>x &amp; y</div>');
    expect(out).toContain('Hi there');
    expect(out).toContain('x & y');
    expect(out).not.toContain('<');
    expect(htmlToText('<p>a</p>\n\n\n\n<p>b</p>')).toBe('a\n\nb');
  });
});

describe('announcementSlug', () => {
  it('date + sanitized title with fallbacks', () => {
    expect(announcementSlug({ posted_at: '2026-04-26T10:55:20Z', title: 'Peer/Appraisal' })).toBe(
      '2026-04-26-Peer_Appraisal',
    );
    expect(announcementSlug({ title: 'X' }).startsWith('undated-')).toBe(true);
    expect(announcementSlug({ posted_at: '2026-04-26T00:00:00Z' }).endsWith('-untitled')).toBe(true);
  });
});

describe('renderAnnouncement', () => {
  const a = { title: 'T', posted_at: '2026-04-26T10:55:20Z', user_name: 'A', html_url: 'U', message: '<p>Body</p>' };
  it('header + body + attachments, omit section when none', () => {
    const md = renderAnnouncement(a, ['x.pdf']);
    expect(md).toContain('# T');
    expect(md).toContain('Body');
    expect(md).toContain('## Attachments');
    expect(md).toContain('x.pdf');
    expect(renderAnnouncement(a, [])).not.toContain('## Attachments');
  });
});

describe('list* pagination', () => {
  it('aggregates pages and drops locked files', async () => {
    const f = async (url) =>
      String(url).includes('page=2')
        ? jsonResponse([{ id: 2, locked_for_user: false }], null)
        : jsonResponse([{ id: 1, locked_for_user: false }], '<https://c/x?page=2>; rel="next"');
    expect((await listActiveCourses({ baseUrl: 'https://c', token: 't', fetchImpl: f })).map((x) => x.id)).toEqual([1, 2]);
    const lockedF = async () =>
      jsonResponse([{ id: 1, locked_for_user: false }, { id: 2, locked_for_user: true }], null);
    expect((await listCourseFiles({ baseUrl: 'https://c', token: 't', fetchImpl: lockedF }, 9)).map((x) => x.id)).toEqual([1]);
    expect((await listCourseAnnouncements({ baseUrl: 'https://c', token: 't', fetchImpl: lockedF }, 9)).length).toBe(2);
  });
});

describe('syncCanvas hub layout', () => {
  let hub;
  beforeEach(() => {
    hub = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-'));
  });
  afterEach(() => fs.rmSync(hub, { recursive: true, force: true }));

  const courses = [{ id: 1, course_code: 'ME2112' }];
  const files = { 1: [{ id: 10, display_name: 'a.pdf', url: 'https://dl/10', size: 4, updated_at: 't1' }] };
  const ann = {
    id: 500,
    title: 'Hello',
    posted_at: '2026-04-26T10:55:20Z',
    message: '<p>Hi</p>',
    attachments: [
      { id: 9001, display_name: 'r.pdf', url: 'https://dl/9001', size: 4, updated_at: 't1', locked_for_user: false },
      { id: 9002, display_name: 'locked.pdf', url: '', size: 4, updated_at: 't1', locked_for_user: true },
    ],
  };
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes('/api/v1/courses?')) return jsonResponse(courses, null);
    const fm = u.match(/\/courses\/(\d+)\/files/);
    if (fm) return jsonResponse(files[Number(fm[1])] ?? [], null);
    if (u.includes('only_announcements')) return jsonResponse([ann], null);
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      arrayBuffer: async () => new TextEncoder().encode('X').buffer,
    };
  };

  it('writes academic/<course>/{canvas,user}, read-only, namespaced manifest', async () => {
    const s = await syncCanvas({ baseUrl: 'https://c', token: 't', fetchImpl }, { hubDir: hub });
    expect(s.courses).toBe(1);
    expect(s.downloaded).toBe(2); // file + accessible attachment
    expect(s.announcements).toBe(1);
    const base = path.join(hub, 'academic', 'me2112');
    expect(fs.statSync(path.join(base, 'user')).isDirectory()).toBe(true);
    const file = path.join(base, 'canvas', 'a.pdf');
    expect(fs.statSync(file).mode & 0o777).toBe(0o444);
    expect(fs.existsSync(path.join(base, 'canvas', 'announcements', '2026-04-26-Hello.md'))).toBe(true);
    expect(fs.existsSync(path.join(base, 'canvas', 'announcements', '2026-04-26-Hello--r.pdf'))).toBe(true);
    expect(fs.existsSync(path.join(base, 'canvas', 'announcements', '2026-04-26-Hello--locked.pdf'))).toBe(false);
    const man = JSON.parse(fs.readFileSync(path.join(hub, 'academic', '.canvas-manifest.json'), 'utf-8'));
    expect(man['10']).toBeTruthy();
    expect(man['ann:500']).toBeTruthy();
    expect(man['att:9001']).toBeTruthy();
    const s2 = await syncCanvas({ baseUrl: 'https://c', token: 't', fetchImpl }, { hubDir: hub });
    expect(s2.downloaded).toBe(0);
    expect(s2.announcements).toBe(0);
  });
});

describe('resolveHubDir', () => {
  let root;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  it('prefers the explicit arg', () => {
    expect(resolveHubDir(root, '/tmp')).toBe(fs.realpathSync(root) === root ? root : path.resolve(root));
  });
  it('walks up to the dir holding .claude', () => {
    fs.mkdirSync(path.join(root, '.claude'));
    const deep = path.join(root, 'academic', 'me2112');
    fs.mkdirSync(deep, { recursive: true });
    expect(resolveHubDir(undefined, deep)).toBe(root);
  });
  it('falls back to cwd', () => {
    expect(resolveHubDir(undefined, root)).toBe(root);
  });
});
