# Canvas LMS connector — design

Date: 2026-07-26
Status: approved for implementation
Related: `docs/superpowers/specs/2026-07-20-comms-memory-ux-design.md` (roadmap stub:
"Canvas/academic connector")

## Purpose

Pull Jeon's Canvas LMS activity into Icarus digests the same way mail does: scheduled
checks surface only what is new; an on-demand command always answers. First-seen
assignments with due dates become Google Calendar events when the calendar MCP is
configured.

## Goals

- Ingest announcements, due/missing work, and newly posted grades from enrolled /
  favorite courses.
- Run twice daily (morning + evening in `ICARUS_TZ`) plus on-demand via `/canvas`.
- Stay silent on scheduled runs when nothing is new; `/canvas` always acknowledges
  (including a short "Canvas clear").
- Create calendar events only for assignments Icarus has never seen before that have a
  `due_at`.
- Reuse `DIGEST_STYLE` and the mail-style triage DM path.
- Keep Canvas access read-only (GET only). Optional: disabled when env unset.

## Non-goals (v1)

- Submitting work, posting discussions, or any Canvas write.
- Course whitelist / mute UI (auto enrolled + favorite only).
- Canvas webhooks / push (poll only).
- Deep attachment investigation (unlike mail); use API text/HTML fields and links.
- Changing the digest contract.
- Native calendar client code (use existing `ICARUS_CALENDAR_MCP` on agent turns).

## Approach

**Hybrid (Approach 3):** TypeScript owns fetch, pagination, course discovery, and
new-vs-seen classification via `connector_items`. An agent triage turn runs only when
there is a non-empty delta (or on-demand force). The agent composes the digest, writes
calendar events for `needs_calendar` rows, and may update memory. Intelligence stays in
agent turns; new TypeScript is plumbing — consistent with the 2026-07-20 connector
doctrine, but cheaper than dumping raw Canvas JSON for the model to rediscover.

## Architecture

Optional connector, same family as mail.

### Config (`.env`)

| Variable | Role |
|---|---|
| `CANVAS_BASE_URL` | School host, e.g. `https://school.instructure.com` |
| `CANVAS_API_TOKEN` | Personal access token (`Authorization: Bearer …`) |

Both required to enable. Never log the token. Optional cron overrides can wait; defaults
are morning + evening in `ICARUS_TZ` (concrete clock times fixed in the implementation
plan, e.g. 08:00 and 18:00).

### Runtime pieces

1. **`src/connectors/canvas.ts`** — HTTP client (GET-only), course discovery, pulls,
   dedupe, delta write, enqueue.
2. **Scheduler** — two system crons calling the poller; `/canvas` uses the same path with
   `force=true`.
3. **`job:canvas-triage`** — fresh session, `DIGEST_STYLE`, calendar MCP attached like
   other turns. Prompt points at the delta file(s) and instructs calendar creates only for
   `needs_calendar` items.
4. **`/status`** — Canvas line: configured?, last poll ok/fail, last digest time.

No generic connector framework. No Canvas writes.

## Canvas API surface (v1)

Auth: `Authorization: Bearer <token>` over HTTPS to `{CANVAS_BASE_URL}/api/v1/…`.
Paginate with Canvas Link headers / usual `per_page` pattern.

| Need | Endpoint (representative) |
|---|---|
| Courses | `GET /api/v1/courses` — keep active enrolled; include favorites when marked |
| Announcements | `GET /api/v1/announcements?context_codes[]=course_<id>&start_date=…` |
| Due / missing | `GET /api/v1/users/self/missing_submissions` and/or per-course assignments with `due_at` + submission state |
| Grades | Course student submissions / grade fields; treat newly posted grades as items |

Exact request params and response field mapping are implementation details; the design
requires the four item classes below.

## Data flow

1. List courses; keep active enrolled (+ favorite when available).
2. Fetch announcements, assignments/due/missing, and grades for those courses, bounded by
   a last-success watermark where useful (announcement `start_date`, incremental scans).
3. Classify each candidate against `connector_items` (`source = 'canvas'`):

   | Item id pattern | Meaning |
   |---|---|
   | `announcement:<id>` | New announcement |
   | `assignment:<id>` | First-seen assignment; if `due_at` set → flag `needs_calendar` |
   | `grade:<assignment_id>:<graded_at>` | Newly posted grade (fire once; use `graded_at` or Canvas equivalent timestamp; if none, use `score` + `grade` string) |
   | `missing:<assignment_id>` | Include when an assignment newly appears on the missing-submissions list |

4. If no new items and not forced → exit (no turn, no DM).
5. Else write a structured delta under
   `inbox/connectors/canvas/<YYYY-MM-DD>/<runId>.md` (optional JSON sibling for machine
   fields), `markProcessed` for included item ids, enqueue `job:canvas-triage`.
6. Triage: digest → DM if non-empty; calendar creates for `needs_calendar` when MCP is
   up; durable facts → memory. On failure, DM a short error and leave delta files on disk
   (mail pattern).

**Watermark:** settings / `connector_state` key for last successful poll time. Item-level
dedupe remains the source of truth for "already told you."

**On-demand:** same pipeline with `force=true`. Empty delta → one short "Canvas clear"
reply (scheduled stays silent).

## Error handling

| Failure | Behavior |
|---|---|
| Env unset / incomplete | Connector off; `/canvas` says not configured |
| 401 / 403 | One owner DM; `/status` shows auth failed; skip polls until token fix + `/restart` |
| Transient 5xx / network | Log; retry next schedule; no DM spam |
| 429 rate limit | Abort this run; resume next schedule |
| Triage fails | Short DM + paths to preserved delta files |
| Calendar MCP unset | Digest still sends; skip calendar; if any `needs_calendar` existed, one digest line that calendar was unavailable |

## Security posture

- Token only in `.env`; never committed; never logged.
- GET-only Canvas client.
- Prompt-injection posture matches mail v1: triage turns use the normal toolset; Canvas
  content is treated as owner-trusted academic material. Recorded accepted risk; revisit
  if a course feed becomes hostile.

## Testing

- Unit: item-id helpers, new-vs-seen classification, course filter, empty→no-enqueue vs
  force→clear reply.
- `npm run typecheck` clean; `npm run selftest` reports Canvas config set/unset like other
  optional connectors.
- Manual smoke with real school host + token: `/canvas` surfaces announcement, due, grade;
  first-seen assignment creates a calendar event when MCP is up; second `/canvas` is clear;
  calendar unset → digest-only path.

## Success criteria

- Twice daily: DM only when something new matters; `/canvas` always answers.
- First-seen dated assignments become calendar events when calendar MCP is configured.
- Unsetting Canvas env removes the connector with no boot failure.

## Delivery

One implementation plan (not split across mail-style phases). Ship behind env flags;
extend `/status` and README setup notes in the same plan.
