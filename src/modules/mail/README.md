# mail module

Reads a daily Outlook `.pst` export, sorts it by relevance, reads the mail that matters, and
files what's worth keeping into the raw archive.

## Required env

- `ICARUS_MAIL_DROP` — folder where daily Outlook `.pst` exports land

Missing it fails boot. `--selftest` uses `state/selftest-mail-drop` under the repo.

## The sweep

One daily schedule, `mail-sweep` (`0 7 * * *`, seeded into the `schedules` table so it shows up
in `/schedules` and can be retimed there). Four stages, DB state between each, so any stage can
stop mid-way and resume on the next fire or after a restart:

| Stage | Where it runs | What it does |
|---|---|---|
| discover | code | quiet `*.pst` in the drop dir → a `mail_exports` row |
| census | code | walks the PST writing **headers only** into `mail_messages` — no bodies, no attachments, no files |
| rank | off the queue | sender verdicts, then per-message ranks |
| triage | on the queue | materializes the winners, reads them, emits JSON; the runtime files |

A `.pst` is ready once its mtime has been quiet for 10 minutes — one observation, not two polls.
The old two-poll rule would silently never fire on a daily cadence, because a fresh export every
day means the size and mtime never repeat.

The census writes no files on purpose. A 2.8 GB mailbox is tens of thousands of messages; writing
a markdown file per message before anything has judged it would put ~100k files and gigabytes of
newsletter HTML into `0_Inbox` up front. Bodies and attachments are extracted only for messages
that rank at or above the read threshold.

## The filter — relevance, not rules

There are no folder exclusions, date cutoffs, or header heuristics. The model does the judging,
in two tiers:

1. **Sender verdicts.** A noisy mailbox is tens of thousands of messages but only a couple of
   thousand correspondents, so judging the correspondent first collapses the work by 20-30×.
   `noise` and `relevant` settle every message from that sender at once; `sometimes` passes them
   on to per-message ranking.
2. **Per-message ranks** — `3 act`, `2 keep`, `1 skim`, `0 noise` — for mail from `sometimes`
   senders only.

Both run off the turn queue via the `oneShot` shape from `improve/evals.ts`: cheap model, no
tools, no MCP, no persona, no session. A multi-hour backlog pass must never occupy the single
global lane, which is what would starve Telegram DMs.

Unparseable ranker output releases the window and retries rather than defaulting. There is no
fallback rank: defaulting to important floods triage, defaulting to noise silently buries real
mail. Three strikes parks the row in `rank_failed`.

## Filing

The agent never files into the raw archive itself (`persona/persona.md`). It emits JSON and the
runtime performs the writes through `fileToRaw`:

- `file[]` — an attachment already on disk, resolved inside that message's own `-att` dir.
- `documents[]` — bytes the agent produced by following a link and downloading to the temp dir.
- `links[]` — a page worth remembering. Recorded in `mail_links`, never filed; `fileToRaw` needs
  bytes on disk, so a URL is not fileable.

Raw immutability is intact — `fileToRaw` never overwrites, it disambiguates. Guardrails, since
filing is unattended: slug validated against `listShelvableProjects()` (unknown → a question in
the digest, not a write), attachment paths must stay inside their message dir, document paths
must be absolute and outside the data root, inline HTML assets and sub-20 KB images are dropped
before the model ever sees them, and a per-fire filing budget caps the blast radius of a bad run.

`mail_filed` is the audit trail. Immutability means a misroute cannot be deleted — being able to
enumerate one is the only recovery affordance.

## `/mail`

Backlog and export state, the read threshold, sender verdicts (tap to overrule), what got filed,
and kept links. `run now` triggers a sweep out of cycle. Free-text config is `/mail policy <text>`
and `/mail threshold <0-3>`. Every callback embeds a DB row id, so buttons survive `/restart`.

## Tables

`mail_exports` (one per physical export, with the resume cursor), `mail_messages` (headers, rank,
state), `mail_senders` (the filter), `mail_filed` and `mail_links` (audit).

## Failure modes

Poison PST → salvaged rows keep flowing; after 3 attempts the export parks in `error` with one DM
and is never auto-retried. Rank failure → window released; after 3, `paused` with one DM. Message
won't materialize → `materialize_failed`, named in the digest. Triage turn fails → rows released
to `ranked`. Crash mid-sweep → `onStart` releases `ranking`→`new` and `queued`→`ranked`; nothing
double-files, because `raw_shelf` dedups on sha256 and `fileToRaw` never overwrites.

The sweep guards its own re-entry: `scheduler.ts` fires `onFire` with a discarded promise, so
croner's `protect` cannot see an overrun. `catch_up` is off for the same reason — a make-up fire
could stack a second walk on a backlog pass still running from the scheduled one.

Losing the old 5-minute poll means a mid-day export waits until the next morning unless you tap
`run now`.
