import { describe, expect, it } from 'vitest';
import { selectCourses } from '../../src/ingest/canvas.js';
import type { SourcesConfig } from '../../src/config/sources.js';

const all: SourcesConfig = {
  canvas: { courses: [], modules: [] },
  outlook: { senderAllow: [], folderAllow: [], folderBlock: [] },
};
const restricted: SourcesConfig = {
  canvas: { courses: ['101'], modules: [] },
  outlook: { senderAllow: [], folderAllow: [], folderBlock: [] },
};
const courses = [
  { id: '101', name: 'Intro' },
  { id: '202', name: 'Advanced' },
];

describe('selectCourses', () => {
  it('empty allowlist selects all', () => {
    expect(selectCourses(courses, all)).toHaveLength(2);
  });
  it('non-empty allowlist filters', () => {
    expect(selectCourses(courses, restricted)).toEqual([{ id: '101', name: 'Intro' }]);
  });
});
