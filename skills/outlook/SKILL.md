---
name: outlook
description: Ingest the daily NUS Outlook .pst export into a read-only email/ mirror and surface important mail into index.md. Use when the operator asks to sync, check, refresh, or pull their NUS email/inbox.
---

# Outlook email ingest

Ingest the operator's NUS mailbox (a daily full `.pst` export at the hub root)
into `<hub>/email/` and surface what matters into `index.md`.

## 1. Run the ingester

```bash
node ${CLAUDE_SKILL_DIR}/scripts/sync.mjs
```

- Needs `readpst` (libpst) on `PATH` and a `.pst` in the hub root
  (auto-detected; override with `OUTLOOK_PST_PATH`). Self address is derived
  from the `.pst` filename; override with `OUTLOOK_SELF` (comma-separated).
- Writes read-only message notes to `email/<year>/`, hash-deduped attachments to
  `email/attachments/`, dedups by `Message-ID` via `email/.email-manifest.json`,
  and emits `email/.triage.json`. First run also archives the whole backlog
  silently and triages the last 40 days.
- Report the printed summary line to the operator.

## 2. Curate the index

Read `<hub>/email/.triage.json`. Each candidate is mail the script judged
*possibly* important (bulk/newsletter mail is already filtered out). **You make
the final call.** For the ones that genuinely need the operator's attention
(deadlines, action items, someone waiting on a reply, meetings):

- Update an `## Inbox` section in `<hub>/index.md` (create it if missing), each
  line: `[subject](email/<year>/<file>.md) — short hook (who / what / by when)`.
- Collapse a thread to a single line; dedup against entries already there.
- Skip anything routine or purely informational. Leave `wiki/*.md` untouched.

Keep it tight — the index is a curated surface, not an inbox dump.
