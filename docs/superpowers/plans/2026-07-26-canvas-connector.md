# Canvas LMS Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Optional Canvas LMS connector that polls enrolled/favorite courses twice daily (plus `/canvas`), writes a structured delta of new announcements / assignments / grades / missing work, and enqueues a digest triage turn that can create calendar events for first-seen dated assignments.

**Architecture:** Hybrid Approach 3 — TypeScript owns GET-only Canvas HTTP, pagination, course filter, `connector_items` dedupe, and delta files under `inbox/connectors/canvas/`. Agent turn `job:canvas-triage` only runs when the delta is non-empty (or `/canvas` forced). Calendar via existing `ICARUS_CALENDAR_MCP` on the triage turn. Same family as mail (`src/connectors/mail.ts`).

**Tech Stack:** TypeScript ESM, Node 24 `fetch`, croner, existing `connector_items` / settings / queue / `DIGEST_STYLE`. No new npm deps.

**Spec:** `docs/superpowers/specs/2026-07-26-canvas-connector-design.md`

## Global Constraints

- `npm run typecheck` clean; `npm run selftest` prints `ok`; `npm test` green after every task.
- Queue stays single-lane (`submitTurn` only). No new concurrency.
- Canvas client is GET-only — never POST/PUT/DELETE to Canvas.
- Connector optional: both `CANVAS_BASE_URL` and `CANVAS_API_TOKEN` required; unset = disabled, boot still succeeds.
- Never log or commit the API token. Never commit `.env`, `state/`, `inbox/`, real course content.
- Item ids use `source='canvas'` in `connector_items` with patterns from the spec (`announcement:`, `assignment:`, `grade:`, `missing:`).
- Scheduled empty delta → no turn, no DM. Forced empty → "Canvas clear" reply.
- Crons: `0 8 * * *` and `0 18 * * *` with `{ protect: true, timezone: cfg.tz }`.
- Reuse `DIGEST_STYLE`; do not invent a new digest format.
- Append-only migrations only if needed — v1 should need **no** DDL (reuse `connector_items` + settings).
- Test files import `./env.js` first (see `tests/env.ts` → compiled as `.js` import path used by existing tests: `import './env.js'`).
- Commits: plain imperative, no attribution; if identity unset use `Jeon Wonje` / `jeonwonje04@gmail.com` via `git -c user.name=... -c user.email=...`.

## File structure

| File | Responsibility |
|---|---|
| `src/config.ts` | `CANVAS_BASE_URL`, `CANVAS_API_TOKEN` → `cfg.canvasBaseUrl`, `cfg.canvasApiToken` |
| `.env.example` | Document the two vars |
| `src/connectors/canvasIds.ts` | Pure item-id + course-filter + grade-key helpers |
| `src/connectors/canvasDelta.ts` | Classify candidates vs `isProcessed`; render delta markdown |
| `src/connectors/canvasClient.ts` | GET-only paginated Canvas HTTP (injectable `fetch`) |
| `src/connectors/canvas.ts` | Poll orchestration, delta write, triage enqueue, crons, `/canvas` entry |
| `src/main.ts` | `registerCanvasWatcher()` |
| `src/telegram/bot.ts` | `/canvas` command + status line |
| `README.md` | Short setup note |
| `tests/canvas-*.test.ts` | Unit tests |

---

### Task 1: Config + selftest + env docs

**Files:**
- Modify: `src/config.ts`
- Modify: `.env.example`
- Modify: `src/main.ts` (selftest print line only)
- Test: extend coverage via selftest (no new test file required if selftest asserts visibly)

**Interfaces:**
- Produces: `cfg.canvasBaseUrl?: string`, `cfg.canvasApiToken?: string`
- Consumes: existing Env zod object

- [ ] **Step 1: Add env fields and cfg entries**

In `src/config.ts` Env object, after `ICARUS_CALENDAR_MCP`:

```ts
  CANVAS_BASE_URL: z.string().optional(),
  CANVAS_API_TOKEN: z.string().optional(),
```

In `cfg`, after `calendarMcp`:

```ts
  canvasBaseUrl: (env.CANVAS_BASE_URL || '').replace(/\/$/, '') || undefined,
  canvasApiToken: env.CANVAS_API_TOKEN || undefined,
```

Empty string must become `undefined`. Strip trailing slash from base URL.

- [ ] **Step 2: Document in `.env.example`**

```
# Optional: Canvas LMS (school host + personal access token from Canvas Account → Settings → New Access Token)
CANVAS_BASE_URL=
CANVAS_API_TOKEN=
```

- [ ] **Step 3: Selftest line in `src/main.ts`**

After the mail/tg calendar selftest lines, add:

```ts
  console.log(`  canvas: ${cfg.canvasBaseUrl && cfg.canvasApiToken ? cfg.canvasBaseUrl : 'unset'}`);
```

Never print the token.

- [ ] **Step 4: Verify**

Run: `npm run typecheck`  
Expected: clean  
Run: `npm run selftest`  
Expected: includes `canvas: unset` (or base URL if env set) and ends with `ok`

- [ ] **Step 5: Commit**

```bash
git add src/config.ts .env.example src/main.ts
git commit -m "Add optional Canvas LMS env config."
```

---

### Task 2: Item ids, course filter, delta classification + render

**Files:**
- Create: `src/connectors/canvasIds.ts`
- Create: `src/connectors/canvasDelta.ts`
- Test: `tests/canvas-delta.test.ts`

**Interfaces:**
- Produces:
  - `announcementItemId(id: number | string): string` → `announcement:<id>`
  - `assignmentItemId(id: number | string): string` → `assignment:<id>`
  - `gradeItemId(assignmentId: number | string, gradedAt: string | null, score: number | null, grade: string | null): string`
  - `missingItemId(assignmentId: number | string): string` → `missing:<id>`
  - `filterActiveCourses(courses: CanvasCourse[]): CanvasCourse[]`
  - `type CanvasCourse = { id: number; name: string; workflow_state?: string; enrollments?: { type: string; enrollment_state: string }[]; is_favorite?: boolean }`
  - `type CanvasCandidate = { itemId: string; kind: 'announcement' | 'assignment' | 'grade' | 'missing'; title: string; courseName: string; body: string; dueAt?: string | null; needsCalendar?: boolean; locator?: string }`
  - `classifyNew(candidates: CanvasCandidate[], isSeen: (itemId: string) => boolean): CanvasCandidate[]`
  - `renderDeltaMd(runAt: string, items: CanvasCandidate[]): string`

- [ ] **Step 1: Write failing tests**

Create `tests/canvas-delta.test.ts`:

```ts
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
  ]);
  assert.deepEqual(kept.map((c) => c.id).sort(), [1, 2]);
});

test('classifyNew drops seen ids and flags needsCalendar on first-seen dated assignments', () => {
  const seen = new Set(['announcement:1']);
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
    ],
    (id) => seen.has(id),
  );
  assert.equal(out.length, 2);
  assert.equal(out[0]!.itemId, 'assignment:2');
  assert.equal(out[0]!.needsCalendar, true);
  assert.equal(out[1]!.needsCalendar, false);
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
```

- [ ] **Step 2: Run tests — expect FAIL**

Run: `npx tsx --test tests/canvas-delta.test.ts`  
Expected: FAIL (modules missing)

- [ ] **Step 3: Implement `src/connectors/canvasIds.ts`**

```ts
export type CanvasCourse = {
  id: number;
  name: string;
  workflow_state?: string;
  enrollments?: { type: string; enrollment_state: string }[];
  is_favorite?: boolean;
};

export function announcementItemId(id: number | string): string {
  return `announcement:${id}`;
}

export function assignmentItemId(id: number | string): string {
  return `assignment:${id}`;
}

export function missingItemId(id: number | string): string {
  return `missing:${id}`;
}

/** Prefer graded_at; else score+grade string. */
export function gradeItemId(
  assignmentId: number | string,
  gradedAt: string | null,
  score: number | null,
  grade: string | null,
): string {
  if (gradedAt) return `grade:${assignmentId}:${gradedAt}`;
  return `grade:${assignmentId}:${score ?? 'null'}:${grade ?? 'null'}`;
}

/** Active student enrollments (and favorites that are still available student enrollments). */
export function filterActiveCourses(courses: CanvasCourse[]): CanvasCourse[] {
  return courses.filter((c) => {
    if (c.workflow_state && c.workflow_state !== 'available' && c.workflow_state !== 'unpublished') {
      // still allow available; drop completed/deleted
      if (c.workflow_state === 'completed' || c.workflow_state === 'deleted') return false;
    }
    if (c.workflow_state === 'completed' || c.workflow_state === 'deleted') return false;
    const ens = c.enrollments ?? [];
    const studentActive = ens.some(
      (e) => e.type === 'student' && (e.enrollment_state === 'active' || e.enrollment_state === 'invited'),
    );
    return studentActive;
  });
}
```

Simplify the filter — exact implementation to satisfy the test:

```ts
export function filterActiveCourses(courses: CanvasCourse[]): CanvasCourse[] {
  return courses.filter((c) => {
    if (c.workflow_state === 'completed' || c.workflow_state === 'deleted') return false;
    const ens = c.enrollments ?? [];
    return ens.some(
      (e) => e.type === 'student' && (e.enrollment_state === 'active' || e.enrollment_state === 'invited'),
    );
  });
}
```

(Favorites with active student enrollment are kept automatically; teacher-only dropped.)

- [ ] **Step 4: Implement `src/connectors/canvasDelta.ts`**

```ts
export type CanvasCandidate = {
  itemId: string;
  kind: 'announcement' | 'assignment' | 'grade' | 'missing';
  title: string;
  courseName: string;
  body: string;
  dueAt?: string | null;
  needsCalendar?: boolean;
  locator?: string;
};

export function classifyNew(
  candidates: CanvasCandidate[],
  isSeen: (itemId: string) => boolean,
): CanvasCandidate[] {
  const out: CanvasCandidate[] = [];
  for (const c of candidates) {
    if (isSeen(c.itemId)) continue;
    const needsCalendar = c.kind === 'assignment' && !!c.dueAt;
    out.push({ ...c, needsCalendar });
  }
  return out;
}

export function renderDeltaMd(runAt: string, items: CanvasCandidate[]): string {
  const lines = [`# Canvas delta`, ``, `run_at: ${runAt}`, `count: ${items.length}`, ``];
  for (const it of items) {
    lines.push(`## ${it.kind}: ${it.title}`);
    lines.push(`item_id: ${it.itemId}`);
    lines.push(`course: ${it.courseName}`);
    if (it.dueAt) lines.push(`due_at: ${it.dueAt}`);
    lines.push(`needs_calendar: ${it.needsCalendar ? 'yes' : 'no'}`);
    if (it.locator) lines.push(`locator: ${it.locator}`);
    lines.push(``);
    lines.push(it.body.trim() || '(empty)');
    lines.push(``);
  }
  return lines.join('\n');
}
```

- [ ] **Step 5: Run tests — expect PASS**

Run: `npx tsx --test tests/canvas-delta.test.ts`  
Expected: all pass

- [ ] **Step 6: Commit**

```bash
git add src/connectors/canvasIds.ts src/connectors/canvasDelta.ts tests/canvas-delta.test.ts
git commit -m "Add Canvas item-id and delta helpers."
```

---

### Task 3: Canvas HTTP client (GET-only, injectable fetch)

**Files:**
- Create: `src/connectors/canvasClient.ts`
- Test: `tests/canvas-client.test.ts`

**Interfaces:**
- Produces:
  - `type CanvasFetch = typeof fetch`
  - `class CanvasAuthError extends Error`
  - `class CanvasRateLimitError extends Error`
  - `createCanvasClient(opts: { baseUrl: string; token: string; fetchImpl?: CanvasFetch })`
  - Methods: `listCourses()`, `listAnnouncements(contextCodes: string[], startDate: string)`, `listMissingSubmissions()`, `listStudentSubmissions(courseId: number)`, `listAssignments(courseId: number)`
  - All methods paginate via `Link: <url>; rel="next"` until exhausted; `per_page=100`

**Consumes:** none from Task 2 (pure HTTP)

- [ ] **Step 1: Write failing tests with mock fetch**

```ts
import './env.js';

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CanvasAuthError, CanvasRateLimitError, createCanvasClient } from '../src/connectors/canvasClient.js';

test('Authorization Bearer header and strips trailing slash', async () => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push(String(input));
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('Authorization'), 'Bearer secret-token');
    assert.equal(headers.get('Accept'), 'application/json');
    return new Response(JSON.stringify([{ id: 1, name: 'CS' }]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const client = createCanvasClient({
    baseUrl: 'https://school.instructure.com/',
    token: 'secret-token',
    fetchImpl,
  });
  const courses = await client.listCourses();
  assert.equal(courses.length, 1);
  assert.match(calls[0]!, /^https:\/\/school\.instructure\.com\/api\/v1\/courses\?/);
});

test('paginates via Link rel=next', async () => {
  let n = 0;
  const fetchImpl: typeof fetch = async () => {
    n++;
    if (n === 1) {
      return new Response(JSON.stringify([{ id: 1 }]), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          Link: '<https://school.instructure.com/api/v1/courses?page=2&per_page=100>; rel="next"',
        },
      });
    }
    return new Response(JSON.stringify([{ id: 2 }]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const client = createCanvasClient({
    baseUrl: 'https://school.instructure.com',
    token: 't',
    fetchImpl,
  });
  const courses = await client.listCourses();
  assert.deepEqual(courses.map((c) => c.id), [1, 2]);
});

test('401 throws CanvasAuthError', async () => {
  const client = createCanvasClient({
    baseUrl: 'https://school.instructure.com',
    token: 'bad',
    fetchImpl: async () => new Response('nope', { status: 401 }),
  });
  await assert.rejects(() => client.listCourses(), CanvasAuthError);
});

test('429 throws CanvasRateLimitError', async () => {
  const client = createCanvasClient({
    baseUrl: 'https://school.instructure.com',
    token: 't',
    fetchImpl: async () => new Response('slow', { status: 429 }),
  });
  await assert.rejects(() => client.listCourses(), CanvasRateLimitError);
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npx tsx --test tests/canvas-client.test.ts`

- [ ] **Step 3: Implement `src/connectors/canvasClient.ts`**

Implement `createCanvasClient` with:
- Private `getJson(pathOrUrl: string): Promise<unknown>` that only uses GET
- Parse Link header for `rel="next"` (support multiple comma-separated links)
- `listCourses`: `GET /api/v1/courses?enrollment_state=active&include[]=favorites&per_page=100` then also request with enrollments include if needed: `include[]=favorites&include[]=enrollment_term&include[]=total_scores` — minimum: `?enrollment_state=active&include[]=favorites&per_page=100`. To get enrollment objects for filtering, use `include[]=enrollment_term` is wrong — use Canvas `include[]=` for enrollments: actually the courses endpoint returns enrollments when you pass nothing special on some instances; for reliability use:

  `GET /api/v1/courses?enrollment_state=active&include[]=favorites&per_page=100`

  And document that `filterActiveCourses` treats missing enrollments as keep-if-available: **update filter** only if needed. Prefer requesting:

  ```
  /api/v1/courses?enrollment_state=active&include[]=favorites&per_page=100
  ```

  Canvas returns the caller's enrollments on each course by default for the user endpoint. If `enrollments` missing, `filterActiveCourses` should keep courses with `workflow_state` available/undefined (adjust Task 2 filter if client tests force it — keep Task 2 tests green; if enrollments absent, treat as student-active).

  **Amend `filterActiveCourses` in this task if needed:** when `enrollments` is missing/empty and workflow is not completed/deleted, keep the course (API already scoped `enrollment_state=active`).

- `listAnnouncements(contextCodes, startDate)` → `GET /api/v1/announcements?context_codes[]=course_1&...&start_date=YYYY-MM-DD&per_page=100`
- `listMissingSubmissions()` → `GET /api/v1/users/self/missing_submissions?include[]=course&per_page=100`
- `listAssignments(courseId)` → `GET /api/v1/courses/:id/assignments?per_page=100&order_by=due_at&bucket=upcoming` plus a second call `bucket=past` is optional; v1: one call without bucket to get recent, or `override_assignment_dates=true`
  Use: `GET /api/v1/courses/:id/assignments?per_page=100&order_by=due_at`
- `listStudentSubmissions(courseId)` → `GET /api/v1/courses/:id/students/submissions?student_ids[]=self&include[]=assignment&per_page=100`

Never send the token in query string — header only.

- [ ] **Step 4: Run tests — PASS; typecheck**

Run: `npx tsx --test tests/canvas-client.test.ts`  
Run: `npm run typecheck`

- [ ] **Step 5: If filter amend needed, update `tests/canvas-delta.test.ts` + `canvasIds.ts` and keep all canvas tests green**

- [ ] **Step 6: Commit**

```bash
git add src/connectors/canvasClient.ts src/connectors/canvasIds.ts tests/canvas-client.test.ts tests/canvas-delta.test.ts
git commit -m "Add GET-only Canvas HTTP client."
```

---

### Task 4: Poll orchestration, delta write, triage enqueue, crons

**Files:**
- Create: `src/connectors/canvas.ts`
- Test: `tests/canvas-poll.test.ts`
- Modify: none yet for main/bot (Task 5)

**Interfaces:**
- Produces:
  - `canvasConfigured(): boolean`
  - `registerCanvasWatcher(): void` — no-op if not configured; else two crons
  - `runCanvasPoll(opts: { force: boolean; reply?: (text: string) => void | Promise<void> }): Promise<void>`
  - Settings keys: `canvas_last_poll_at`, `canvas_last_poll_status` (`ok`|`auth`|`error`|`rate`), `canvas_last_digest_at`, `canvas_auth_notified`
  - On auth error: set status `auth`; if `canvas_auth_notified` !== '1', DM once via `sendOwner` (or `reply` if provided) and set notified; skip further work while status is auth until process restart clears… **Spec says skip until token fix + `/restart`.** So: if `getSetting('canvas_last_poll_status') === 'auth'`, `runCanvasPoll` returns early unless env still set — still early-out with message on force. Clearing auth: on successful poll set status `ok` and clear `canvas_auth_notified`. For v1 after auth fail, early-out every run until `/restart` (settings persist — so also allow success path to clear). Simplest: early-out only when status is `auth` **and** not force; on force, retry. On success clear auth flags.

**Consumes:** client, ids, delta, `isProcessed`/`markProcessed` from `store.ts`, `submitTurn`, `DIGEST_STYLE`, `cfg`, `sendOwner`

- [ ] **Step 1: Write failing poll tests with injected client + store**

Design `runCanvasPoll` to accept optional deps for testing:

```ts
export type CanvasPollDeps = {
  client: ReturnType<typeof createCanvasClient>;
  isSeen: (id: string) => boolean;
  markSeen: (id: string) => void;
  writeDelta: (md: string) => string; // returns absolute path
  enqueueTriage: (paths: string[], needsCalendarCount: number) => void;
  nowIso: () => string;
  getWatermark: () => string | null; // ISO last ok poll
  setWatermark: (iso: string) => void;
  getStatus: () => string | undefined;
  setStatus: (s: string) => void;
  notifyAuth: (msg: string) => void;
};
```

Or test pure `buildCandidatesFromPayloads(...)` exported for unit tests — prefer exporting `collectCandidates(client, courses, watermarkStartDate): Promise<CanvasCandidate[]>` and testing classification+write separately.

Minimum tests in `tests/canvas-poll.test.ts`:

1. When `collect`/`classify` yields empty and `force=false`, does not call enqueue; calls no reply.
2. When empty and `force=true`, reply `"Canvas clear"`.
3. When new assignment with dueAt, markSeen called, writeDelta called, enqueueTriage called once.
4. Auth error path sets status and notifyAuth once.

Implement the orchestration so these are testable without live Canvas.

- [ ] **Step 2: Implement `src/connectors/canvas.ts`**

Core flow for production `runCanvasPoll({ force, reply })`:
1. If not `cfg.canvasBaseUrl || cfg.canvasApiToken` → reply/send "Canvas not configured" if force/reply; return.
2. If status auth and !force → return (silent scheduled).
3. Create client; `listCourses` → `filterActiveCourses`.
4. Watermark start_date for announcements: `getSetting('canvas_last_poll_at')?.slice(0,10)` or 14 days ago.
5. Build candidates:
   - announcements → item ids, strip HTML via `html-to-text` `convert`
   - assignments per course → assignment candidates (dueAt from `due_at`)
   - missing submissions → missing candidates
   - submissions with `graded_at` or posted grade → grade candidates
6. `classifyNew` with `(id) => isProcessed('canvas', id)`
7. If empty: if force → reply "Canvas clear"; return. Else return.
8. Write `inbox/connectors/canvas/<YYYY-MM-DD>/<runId>.md` via `mkdirSync`/`writeFileSync`; `markProcessed` each item.
9. `enqueueTriage(path)`:

```ts
function enqueueTriage(deltaPath: string, needsCalendar: number): void {
  const calNote =
    needsCalendar > 0
      ? `There are ${needsCalendar} item(s) marked needs_calendar: yes. If calendar tools are available this turn, create one event per such assignment (title + due_at). If calendar tools are unavailable, include one digest line that calendar was unavailable.`
      : `No needs_calendar items.`;
  const prompt = `You are running the Canvas triage job. A structured delta of NEW Canvas items is at:

${deltaPath}

Read that file. Produce a digest for Jeon. ${calNote}
Record durable academic facts in memory when appropriate.

Your final reply is DMed as the Canvas digest.

${DIGEST_STYLE}`;
  submitTurn({
    jid: 'job:canvas-triage',
    kind: 'job:canvas-triage',
    lines: [{ ts: new Date(), text: prompt }],
    capMs: cfg.reflectionCapMs,
    onDone: (res) => {
      let body: string;
      if (res.status === 'ok') {
        body = res.finalText;
        setSetting('canvas_last_digest_at', now());
      } else {
        body = `canvas triage failed: ${res.error ?? 'unknown'} — delta preserved at ${deltaPath}`;
      }
      if (body.trim()) void sendOwner(body);
    },
  });
}
```

10. On success set `canvas_last_poll_at`, `canvas_last_poll_status=ok`, clear auth notified.
11. `registerCanvasWatcher`: if not configured return; else

```ts
new Cron('0 8 * * *', { protect: true, timezone: cfg.tz }, () => void runCanvasPoll({ force: false }));
new Cron('0 18 * * *', { protect: true, timezone: cfg.tz }, () => void runCanvasPoll({ force: false }));
```

- [ ] **Step 3: Tests pass + typecheck**

Run: `npx tsx --test tests/canvas-poll.test.ts tests/canvas-delta.test.ts tests/canvas-client.test.ts`  
Run: `npm run typecheck`

- [ ] **Step 4: Commit**

```bash
git add src/connectors/canvas.ts tests/canvas-poll.test.ts
git commit -m "Add Canvas poll, delta write, and triage enqueue."
```

---

### Task 5: Wire main, `/canvas`, `/status`, README

**Files:**
- Modify: `src/main.ts` — call `registerCanvasWatcher()` after mail watcher
- Modify: `src/telegram/bot.ts` — `/canvas` + status line + help string
- Modify: `README.md` — short optional Canvas setup
- Test: `tests/canvas-status.test.ts` optional — or rely on exporting a small `canvasStatusLine(): string | null`

**Interfaces:**
- `/canvas` → `runCanvasPoll({ force: true, reply: (t) => ctx.reply(t) })` (owner-only like other commands)
- Status line when configured:
  `▸ canvas · {base host} · poll {status} {last_poll slice} · digest {last_digest slice|never}`

- [ ] **Step 1: Add `canvasStatusLine()` in `canvas.ts` and a tiny test**

```ts
export function canvasStatusLine(): string | null {
  if (!cfg.canvasBaseUrl || !cfg.canvasApiToken) return null;
  const host = cfg.canvasBaseUrl.replace(/^https?:\/\//, '');
  const st = getSetting('canvas_last_poll_status') ?? 'never';
  const poll = getSetting('canvas_last_poll_at')?.slice(0, 16) ?? 'never';
  const dig = getSetting('canvas_last_digest_at')?.slice(0, 16) ?? 'never';
  return `▸ canvas · ${host} · poll ${st} ${poll} · digest ${dig}`;
}
```

Test: with env unset in test process, returns null — set cfg via only testing the string formatter by exporting `formatCanvasStatusLine({ baseUrl, status, pollAt, digestAt })` pure helper to avoid cfg mutation.

Prefer pure:

```ts
export function formatCanvasStatusLine(p: {
  baseUrl: string;
  status: string;
  pollAt: string | undefined;
  digestAt: string | undefined;
}): string {
  const host = p.baseUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
  return `▸ canvas · ${host} · poll ${p.status} ${p.pollAt?.slice(0, 16) ?? 'never'} · digest ${p.digestAt?.slice(0, 16) ?? 'never'}`;
}
```

- [ ] **Step 2: Wire bot**

In `statusText()`, after mail block:

```ts
    ...(cfg.canvasBaseUrl && cfg.canvasApiToken
      ? [
          formatCanvasStatusLine({
            baseUrl: cfg.canvasBaseUrl,
            status: getSetting('canvas_last_poll_status') ?? 'never',
            pollAt: getSetting('canvas_last_poll_at'),
            digestAt: getSetting('canvas_last_digest_at'),
          }),
        ]
      : []),
```

Add command near other commands:

```ts
  bot.command('canvas', async (ctx) => {
    const { runCanvasPoll, canvasConfigured } = await import('../connectors/canvas.js');
    if (!canvasConfigured()) return ctx.reply('Canvas not configured (set CANVAS_BASE_URL and CANVAS_API_TOKEN).');
    await ctx.reply('checking Canvas…');
    await runCanvasPoll({
      force: true,
      reply: (text) => ctx.reply(text),
    });
  });
```

Update unknown-command help string to include `/canvas`.

- [ ] **Step 3: Wire `registerCanvasWatcher` in `main.ts`**

```ts
const { registerCanvasWatcher } = await import('./connectors/canvas.js');
registerCanvasWatcher();
```

- [ ] **Step 4: README**

Under optional sections, add:

```markdown
### Optional: Canvas LMS digests

1. In Canvas: Account → Settings → New Access Token; copy the token.
2. Set `CANVAS_BASE_URL` (e.g. `https://your-school.instructure.com`) and `CANVAS_API_TOKEN` in `.env`.
3. `/restart`, then `/canvas` for an on-demand check. Scheduled polls run at 08:00 and 18:00 in `ICARUS_TZ`.
```

- [ ] **Step 5: Full verify**

Run: `npm run typecheck`  
Run: `npm test`  
Run: `npm run selftest`  
Expected: all green / `ok`

- [ ] **Step 6: Commit**

```bash
git add src/main.ts src/telegram/bot.ts src/connectors/canvas.ts tests/canvas-status.test.ts README.md
git commit -m "Wire Canvas watcher, /canvas, and status."
```

---

## Spec coverage checklist (plan self-review)

| Spec requirement | Task |
|---|---|
| Env `CANVAS_BASE_URL` + `CANVAS_API_TOKEN` | 1 |
| GET-only client, Bearer auth, pagination | 3 |
| Active enrolled (+ favorite via include) courses | 2+3+4 |
| Announcements, assignments, missing, grades | 4 |
| Item id patterns + needs_calendar | 2 |
| Delta under `inbox/connectors/canvas/` | 4 |
| `connector_items` dedupe source `canvas` | 4 |
| Silent scheduled empty; force "Canvas clear" | 4 |
| `job:canvas-triage` + DIGEST_STYLE + calendar note | 4 |
| Crons 08:00 + 18:00 in `ICARUS_TZ` | 4 |
| `/canvas`, `/status` line | 5 |
| Auth/rate/error behavior | 4 |
| Selftest + README | 1, 5 |
| No Canvas writes / no whitelist UI / no webhooks | all (omitted) |
