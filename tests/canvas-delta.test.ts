import './env.js';

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  announcementItemId,
  assignmentItemId,
  filterActiveCourses,
  gradeItemId,
  missingItemId,
} from '../src/connectors/canvasIds.js';
import { classifyNew, renderDeltaMd, type CanvasCandidate } from '../src/connectors/canvasDelta.js';

test('item id helpers', () => {
  assert.equal(announcementItemId(9), 'announcement:9');
  assert.equal(assignmentItemId(3), 'assignment:3');
  assert.equal(missingItemId(3), 'missing:3');
  assert.equal(gradeItemId(3, '2026-07-01T12:00:00Z', 90, 'A'), 'grade:3:2026-07-01T12:00:00Z');
  assert.equal(gradeItemId(3, null, 90, 'A-'), 'grade:3:90:A-');
});

test('filterActiveCourses keeps active student enrollments and favorites', () => {
  const kept = filterActiveCourses([
    {
      id: 1,
      name: 'Active',
      workflow_state: 'available',
      enrollments: [{ type: 'student', enrollment_state: 'active' }],
    },
    {
      id: 2,
      name: 'Fav',
      workflow_state: 'available',
      is_favorite: true,
      enrollments: [{ type: 'student', enrollment_state: 'active' }],
    },
    {
      id: 3,
      name: 'Completed',
      workflow_state: 'completed',
      enrollments: [{ type: 'student', enrollment_state: 'completed' }],
    },
    {
      id: 4,
      name: 'Teacher only',
      workflow_state: 'available',
      enrollments: [{ type: 'teacher', enrollment_state: 'active' }],
    },
    {
      id: 5,
      name: 'No enrollments payload',
      workflow_state: 'available',
    },
  ]);
  assert.deepEqual(kept.map((c) => c.id).sort(), [1, 2, 5]);
});

test('classifyNew drops seen ids and flags needsCalendar only for future-due assignments', () => {
  const seen = new Set(['announcement:1']);
  const nowIso = '2026-07-26T08:00:00.000Z';
  const out = classifyNew(
    [
      {
        itemId: 'announcement:1',
        kind: 'announcement',
        title: 'Old',
        courseName: 'CS',
        body: 'x',
      },
      {
        itemId: 'assignment:2',
        kind: 'assignment',
        title: 'PS1',
        courseName: 'CS',
        body: 'due soon',
        dueAt: '2026-08-01T23:59:00Z',
      },
      {
        itemId: 'assignment:3',
        kind: 'assignment',
        title: 'No due',
        courseName: 'CS',
        body: 'undated',
        dueAt: null,
      },
      {
        itemId: 'assignment:4',
        kind: 'assignment',
        title: 'Past due',
        courseName: 'CS',
        body: 'late',
        dueAt: '2026-07-01T23:59:00Z',
      },
    ],
    (id) => seen.has(id),
    nowIso,
  );
  assert.equal(out.length, 3);
  assert.equal(out[0]!.itemId, 'assignment:2');
  assert.equal(out[0]!.needsCalendar, true);
  assert.equal(out[1]!.itemId, 'assignment:3');
  assert.equal(out[1]!.needsCalendar, false);
  assert.equal(out[2]!.itemId, 'assignment:4');
  assert.equal(out[2]!.needsCalendar, false);
});

test('renderDeltaMd lists needs_calendar explicitly', () => {
  const items: CanvasCandidate[] = [
    {
      itemId: 'assignment:2',
      kind: 'assignment',
      title: 'PS1',
      courseName: 'CS2109',
      body: 'Submit',
      dueAt: '2026-08-01T23:59:00Z',
      needsCalendar: true,
    },
  ];
  const md = renderDeltaMd('2026-07-26T08:00:00Z', items);
  assert.match(md, /needs_calendar: yes/);
  assert.match(md, /assignment:2/);
  assert.match(md, /PS1/);
});
