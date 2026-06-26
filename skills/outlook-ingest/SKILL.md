---
name: outlook-ingest
description: Parse the daily Outlook .pst export into the hub. Use when the user asks to refresh, sync, or update email/Outlook, or asks about recent mail that may be out of date.
---

# Outlook ingest

When the user asks to refresh Outlook/email (or you need newer mail than what is
in `raw/outlook/`), run this command from the hub:

```bash
node "$ICARUS_HOME/dist/ingest/outlook.js"
```

(If `dist/` is absent, use
`npx --prefix "$ICARUS_HOME" tsx "$ICARUS_HOME/src/ingest/outlook.ts"`.)

This reads the daily `.pst` export at `OUTLOOK_PST_PATH` and classifies each message
using `$ICARUS_HOME/sources.config.json`: confident automated junk (block-list senders)
and Haiku-triaged junk go to `raw/outlook/_filtered/`; ambiguous bulk-ish mail is judged
by a cheap model; everything else (personal/human mail) is written to `raw/outlook/`.
Junk is quarantined, never deleted. Attachments are filtered per the attachment rules.
It prints a summary of the form:
`N kept, F filtered (B blocklist + L llm-junk), G gray-triaged, A attachments kept, S skipped`.

After it finishes, file the new `raw/outlook/` messages into `wiki/` as needed and update
`index.md`, citing each `raw/outlook/...` path. Ignore `raw/outlook/_filtered/` unless the
user explicitly asks about filtered/junk mail. If the export is missing or the command
fails, report the error; do not retry blindly.
