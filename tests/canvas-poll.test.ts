import './env.js';

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CanvasAuthError,
  CanvasRateLimitError,
  type CanvasClient,
} from '../src/connectors/canvasClient.js';
import {
  clearCanvasAuthGate,
  runCanvasPoll,
  type CanvasPollDeps,
} from '../src/connectors/canvas.js';

function emptyClient(overrides: Partial<CanvasClient> = {}): CanvasClient {
  return {
    listCourses: async () => [],
    listAnnouncements: async () => [],
    listMissingSubmissions: async () => [],
    listAssignments: async () => [],
    listStudentSubmissions: async () => [],
    ...overrides,
  };
}

function makeDeps(overrides: Partial<CanvasPollDeps> & { client: CanvasClient }): CanvasPollDeps {
  let status: string | undefined;
  let watermark: string | null = null;
  let authNotified = false;
  const seen = new Set<string>();
  return {
    isSeen: (id) => seen.has(id),
    markSeen: (id) => {
      seen.add(id);
    },
    writeDelta: (md) => {
      assert.ok(md.includes('# Canvas delta'));
      return 'C:\\tmp\\canvas-delta.md';
    },
    enqueueTriage: () => {},
    nowIso: () => '2026-07-26T08:00:00.000Z',
    getWatermark: () => watermark,
    setWatermark: (iso) => {
      watermark = iso;
    },
    getStatus: () => status,
    setStatus: (s) => {
      status = s;
    },
    getAuthNotified: () => authNotified,
    setAuthNotified: () => {
      authNotified = true;
    },
    clearAuthNotified: () => {
      authNotified = false;
    },
    notifyAuth: () => {},
    ...overrides,
  };
}

function assignmentClient(): CanvasClient {
  return emptyClient({
    listCourses: async () => [
      {
        id: 10,
        name: 'CS2109',
        workflow_state: 'available',
        enrollments: [{ type: 'student', enrollment_state: 'active' }],
      },
    ],
    listAssignments: async (courseId) => {
      assert.equal(courseId, 10);
      return [
        {
          id: 2,
          name: 'PS1',
          description: '<p>Submit on Canvas</p>',
          due_at: '2026-08-01T23:59:00Z',
          html_url: 'https://school.instructure.com/courses/10/assignments/2',
        },
      ];
    },
  });
}

test('empty and !force does not enqueue or reply', async () => {
  let enqueued = 0;
  let replied: string | undefined;
  await runCanvasPoll({
    force: false,
    reply: (t) => {
      replied = t;
    },
    deps: makeDeps({
      client: emptyClient(),
      getWatermark: () => '2026-07-25T08:00:00.000Z',
      enqueueTriage: () => {
        enqueued++;
      },
    }),
  });
  assert.equal(enqueued, 0);
  assert.equal(replied, undefined);
});

test('empty and force replies Canvas clear', async () => {
  let enqueued = 0;
  let replied: string | undefined;
  await runCanvasPoll({
    force: true,
    reply: (t) => {
      replied = t;
    },
    deps: makeDeps({
      client: emptyClient(),
      getWatermark: () => '2026-07-25T08:00:00.000Z',
      enqueueTriage: () => {
        enqueued++;
      },
    }),
  });
  assert.equal(enqueued, 0);
  assert.equal(replied, 'Canvas clear');
});

test('new dated assignment marks seen, writes delta, enqueues once', async () => {
  const marked: string[] = [];
  const writes: string[] = [];
  const enqueues: { path: string; needsCalendar: number }[] = [];

  await runCanvasPoll({
    force: false,
    deps: makeDeps({
      client: assignmentClient(),
      getWatermark: () => '2026-07-25T08:00:00.000Z',
      markSeen: (id) => {
        marked.push(id);
      },
      writeDelta: (md) => {
        writes.push(md);
        return 'C:\\tmp\\canvas-delta.md';
      },
      enqueueTriage: (deltaPath, needsCalendarCount) => {
        enqueues.push({ path: deltaPath, needsCalendar: needsCalendarCount });
      },
    }),
  });

  assert.deepEqual(marked, ['assignment:2']);
  assert.equal(writes.length, 1);
  assert.match(writes[0]!, /assignment:2/);
  assert.match(writes[0]!, /needs_calendar: yes/);
  assert.equal(enqueues.length, 1);
  assert.equal(enqueues[0]!.path, 'C:\\tmp\\canvas-delta.md');
  assert.equal(enqueues[0]!.needsCalendar, 1);
});

test('no-watermark run marks seen without enqueue', async () => {
  const marked: string[] = [];
  let enqueued = 0;
  let writes = 0;
  let watermark: string | null = null;
  let status: string | undefined;

  await runCanvasPoll({
    force: false,
    deps: makeDeps({
      client: assignmentClient(),
      getWatermark: () => watermark,
      setWatermark: (iso) => {
        watermark = iso;
      },
      getStatus: () => status,
      setStatus: (s) => {
        status = s;
      },
      markSeen: (id) => {
        marked.push(id);
      },
      writeDelta: () => {
        writes++;
        return 'C:\\tmp\\canvas-delta.md';
      },
      enqueueTriage: () => {
        enqueued++;
      },
    }),
  });

  assert.deepEqual(marked, ['assignment:2']);
  assert.equal(enqueued, 0);
  assert.equal(writes, 0);
  assert.equal(status, 'ok');
  assert.equal(watermark, '2026-07-26T08:00:00.000Z');
});

test('force no-watermark replies baseline seeded message', async () => {
  let enqueued = 0;
  let replied: string | undefined;

  await runCanvasPoll({
    force: true,
    reply: (t) => {
      replied = t;
    },
    deps: makeDeps({
      client: assignmentClient(),
      enqueueTriage: () => {
        enqueued++;
      },
    }),
  });

  assert.equal(enqueued, 0);
  assert.equal(replied, 'Canvas baseline seeded — next changes will digest.');
});

test('clearCanvasAuthGate clears auth status and notified flag', () => {
  let status: string | undefined = 'auth';
  let authNotified = true;
  clearCanvasAuthGate({
    getStatus: () => status,
    clearStatus: () => {
      status = undefined;
    },
    clearAuthNotified: () => {
      authNotified = false;
    },
  });
  assert.equal(status, undefined);
  assert.equal(authNotified, false);

  status = 'ok';
  authNotified = true;
  clearCanvasAuthGate({
    getStatus: () => status,
    clearStatus: () => {
      status = undefined;
    },
    clearAuthNotified: () => {
      authNotified = false;
    },
  });
  assert.equal(status, 'ok');
  assert.equal(authNotified, true);
});

test('auth error sets status and notifyAuth once', async () => {
  const statuses: string[] = [];
  const notifies: string[] = [];
  let authNotified = false;

  const client = emptyClient({
    listCourses: async () => {
      throw new CanvasAuthError();
    },
  });

  const deps = makeDeps({
    client,
    getStatus: () => statuses.at(-1),
    setStatus: (s) => {
      statuses.push(s);
    },
    getAuthNotified: () => authNotified,
    setAuthNotified: () => {
      authNotified = true;
    },
    notifyAuth: (msg) => {
      notifies.push(msg);
    },
  });

  await runCanvasPoll({ force: false, deps });
  await runCanvasPoll({ force: false, deps });

  assert.deepEqual(statuses, ['auth']);
  assert.equal(notifies.length, 1);
  assert.match(notifies[0]!, /Canvas auth/i);
  assert.match(notifies[0]!, /\/restart/);
  assert.match(notifies[0]!, /\/canvas/);
});

test('force auth replies even after notifyAuth already fired', async () => {
  let authNotified = true;
  const notifies: string[] = [];
  let replied: string | undefined;

  await runCanvasPoll({
    force: true,
    reply: (t) => {
      replied = t;
    },
    deps: makeDeps({
      client: emptyClient({
        listCourses: async () => {
          throw new CanvasAuthError();
        },
      }),
      getAuthNotified: () => authNotified,
      setAuthNotified: () => {
        authNotified = true;
      },
      notifyAuth: (msg) => {
        notifies.push(msg);
      },
    }),
  });

  assert.equal(notifies.length, 0);
  assert.match(replied!, /Canvas auth failed/i);
});

test('force rate limit replies; scheduled rate stays silent', async () => {
  let replied: string | undefined;
  const client = emptyClient({
    listCourses: async () => {
      throw new CanvasRateLimitError();
    },
  });

  await runCanvasPoll({
    force: false,
    deps: makeDeps({ client }),
  });
  assert.equal(replied, undefined);

  await runCanvasPoll({
    force: true,
    reply: (t) => {
      replied = t;
    },
    deps: makeDeps({ client }),
  });
  assert.match(replied!, /rate limited/i);
});
