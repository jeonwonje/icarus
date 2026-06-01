# outlook — NUS email ingest skill

**Date:** 2026-06-02
**Status:** Approved, ready for implementation

## Problem

A recurring (daily) Outlook export drops the operator's *entire* NUS mailbox as a
single raw `.pst` at the hub root (`<hub>/jeonwonje@u.nus.edu.pst`, ~4.2 GB,
full-snapshot — not a delta). The operator wants a new data-source skill that:

- ingests that mailbox into the hub so it's searchable from a Claude session,
- recognizes that **not all email is important** and surfaces only what matters
  into the hub's curated `index.md`,
- processes older threads **once** ("one shot") and never re-ingests them, even
  though each daily `.pst` re-contains them,
- stores the **many links and attachments** efficiently (no duplication).

This mirrors the existing `canvas` skill's role (read-only mirror in a domain
folder, cited by the curated wiki/index), adapted to email.

## Architecture

Same split as `canvas`:

- **`skills/outlook/scripts/sync.mjs`** — deterministic ETL, dependency-free
  `.mjs` (Node built-ins only, **no npm deps**). The one new external boundary
  vs. canvas: it shells out to **`readpst`** (libpst, already installed at
  `/usr/bin/readpst`) via `node:child_process` — the same role `fetch` plays in
  canvas (impure boundary, pure logic inside). The shell-out is injectable for
  tests (like canvas injects `fetchImpl`).
- **`skills/outlook/SKILL.md`** — drives **Claude** to do the judgment half:
  after the script runs, Claude reads the triage candidates and curates
  `<hub>/index.md`. The script never makes the final "is this important" call.

Invocation: `/outlook`, or auto-trigger on "check/sync my email".

## Pipeline (per run)

1. **Resolve hub** with `resolveHubDir` (reused from canvas: walk up to
   `.claude`/`CLAUDE.md`, else cwd).
2. **Locate the `.pst`**: `OUTLOOK_PST_PATH` env if set, else the newest
   `<hub>/*.pst`. Error + non-zero exit if none found.
3. **Convert**: `readpst -e -o <tmp>` where `<tmp>` is a `mktemp -d` **outside
   OneDrive**. `-e` writes one self-contained RFC822 `.eml` file per message
   (attachments inline as MIME) in a folder tree mirroring the mailbox. A pure
   `parseEml(buffer)` then does header + MIME decoding in `.mjs`, which keeps the
   parser fully unit-testable from hand-written `.eml` fixtures (no `readpst` in
   tests). The exact flags are confirmed against the real `.pst` during the live
   verification step.
4. **Walk** the temp tree. For each message file, parse headers: `Message-ID`,
   `From`, `To`, `Cc`, `Date`, `Subject`, `List-Id`, `Precedence`,
   `In-Reply-To`/`References`; and the readable body.
5. **Dedup by `Message-ID`** against `<hub>/email/.email-manifest.json`. Seen →
   skip (re-read by readpst, never re-written → the "one shot" guarantee).
6. **For each new message**: write the message note (§ Storage), hash-dedup its
   attachments, extract links, compute signals (§ Triage), record in the
   manifest, and append to the triage list if it passes the pre-filter.
7. **finally**: delete the temp dir (no 4 GB litter), persist manifest +
   `.triage.json`, print a one-line summary.

## Storage layout

Read-only mirror (`chmod 0o444` on every written file, canvas pattern):

```
<hub>/email/
  2026/
    2026-06-01-registrar-fee-deadline.md   # year-bucketed to avoid one giant dir
  attachments/
    <sha256>.<ext>                          # each distinct attachment stored ONCE
  .email-manifest.json                      # dedup + state (see below)
  .triage.json                              # new-since-last-run candidates (regen each run)
```

Message note = frontmatter + plain-text body:

```yaml
---
message-id: "<...>"
date: 2026-06-01T09:12:00Z
from: registrar@nus.edu.sg
to: [jeonwonje@u.nus.edu]
cc: []
subject: Fee payment deadline
attachments: [<sha256>.pdf]      # referenced by hash — never inlined
links: [https://...]
signals: { direct: true, bulk: false, internal: true, calendarInvite: false,
           deadlineHit: true, hasAttachment: true, thread: "<...>" }
---
<readable body text>
```

Attachments referenced by hash → the same PDF across 8 thread replies is stored
once. All message bodies are stored (cheap text); attachment bytes are the bulk,
and hash-dedup is what controls footprint.

`.email-manifest.json`:

```json
{
  "baseline": "2026-06-02T...Z",
  "lastRun": "2026-06-02T...Z",
  "messages": { "<message-id>": { "date": "...", "path": "2026/...md",
                                  "attachments": ["<sha256>.pdf"] } }
}
```

## Backlog vs. incremental

- **First run** (empty manifest): ingest + store + hash-dedup the **entire**
  mailbox, mark every `Message-ID` seen, set `baseline = now`. This is a silent
  archive — it does **not** flood the index. **Additionally**, emit triage
  candidates for messages dated within the **last 40 days** so the operator
  starts with recent context.
- **Later runs**: triage only messages dated after `lastRun` (older mail is
  already in the manifest and skipped anyway). `baseline` is set once.

## Triage signals + pre-filter

The script computes cheap, deterministic signals per candidate:

- `direct` (operator in `To`) vs `cc` vs `bulk`
  (`List-Id` present, or `Precedence: bulk/list`, or `no-reply@`/`noreply@`
  sender),
- `internal` (sender domain under `nus.edu.sg`) vs external,
- `calendarInvite` (a `.ics` attachment or `text/calendar` part),
- `deadlineHit` (subject/body matches a keyword set: due, deadline, submit,
  RSVP, action required, "by <date>", payment, etc.),
- `hasAttachment`,
- `thread` (`In-Reply-To`/`References` root, so an already-triaged thread isn't
  re-surfaced).

**Pre-filter:** obvious bulk (`bulk` signal) is dropped from the triage list —
still archived to `email/`, just never shown to the index. Everything else
becomes a `.triage.json` candidate. This is the deterministic "not all email is
important" cut; Claude makes the final call on what survives it.

## Agent curation (the "update the index" half)

`SKILL.md` body instructs Claude, after running the script:

1. Read `<hub>/email/.triage.json`.
2. Update an **`## Inbox`** section in `<hub>/index.md` (create it if absent):
   important threads, deadlines, and who's waiting on a reply — each line
   `[subject](email/2026/<file>.md) — one-line hook`, consistent with the
   existing index style (Projects/Reference/Active).
3. Dedup against entries already in `## Inbox`; collapse a thread to one line.
4. Leave hand-written `wiki/*.md` notes untouched (the operator curates those).

The script writes nothing to `index.md` itself — only Claude does, so importance
stays a judgment call.

## Error handling

- `readpst` not on `PATH` → print "install libpst (readpst) — sudo apt install
  libpst" and exit non-zero.
- No `.pst` found (and no `OUTLOOK_PST_PATH`) → message + exit non-zero.
- Per-message parse / attachment-write failures → counted in the summary, not
  fatal (canvas pattern). Errors list capped in output.
- Temp dir removed in a `finally` even on failure.
- Summary line: messages new / attachments stored / unchanged-skipped / failed /
  bytes, plus triage-candidate count.

## Testing (TDD, vitest over `skills/**/*.test.mjs`)

Pure helpers, tested with injected fixtures; the `readpst` shell-out is injected
(a fake "converted temp dir" or fake exec) exactly as canvas injects `fetchImpl`:

- header parsing, `slug`/`sanitizeName` (reuse canvas helper), `extractLinks`,
- `classifySignals` / `isBulk` / `deadlineHit` / `isInternal`,
- attachment hashing + content-dedup (same bytes → one file),
- manifest dedup (seen `Message-ID` skipped) + incremental persistence,
- baseline-window filtering (first-run 40-day triage; later-run `lastRun` cut),
- `renderMessageMarkdown`, triage-candidate selection (bulk dropped).

The full 4 GB `readpst` conversion is verified **live once** against the real
`.pst`, not in unit tests.

## README + `work` alias

- Add an `### outlook` subsection to `README.md` (mirroring the `### canvas`
  one): what it mirrors, where, that it needs `readpst`, and `/outlook`.
- Document the `work` alias as the hub entry point:
  `work='(cd "<OneDrive>" && claude --remote-control)'` (already in `~/.bashrc`).

## Phasing

1. **Build the skill** — `skills/outlook/{SKILL.md, scripts/sync.mjs,
   scripts/sync.test.mjs}`, dependency-free, `readpst` boundary injected, full
   storage + manifest + triage logic, tests green.
2. **Live verify** — run against the real `.pst` into a temp hub; confirm
   `readpst -S` output shape, attachment dedup, manifest, and `.triage.json`;
   tune flags/heuristics.
3. **Wire into the hub** — the existing `skills` symlink already exposes it; run
   the first real ingest into `<hub>/email/`; confirm `/outlook` triggers and
   Claude curates `index.md`. Update README.

## Out of scope

- Auto-scheduling the daily run (operator invokes `/outlook`; `/schedule` may be
  added later).
- Sending, replying to, or modifying mail.
- Per-subject routing of email into `academic/<course>/` (flat `email/` store
  for now).
- Skipping attachments for bulk mail (hash-dedup already bounds footprint; can
  be tuned later if `email/attachments/` grows large).
