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

This reads the daily `.pst` export at `OUTLOOK_PST_PATH`, applies the
folder/sender allow- and block-lists in `$ICARUS_HOME/sources.config.json`
(Junk is skipped by default), and writes one markdown file per message under
`raw/outlook/`. It prints a summary line.

After it finishes, file the new messages into `wiki/` as needed and update
`index.md`, citing each `raw/outlook/...` path. If the export is missing or the
command fails, report the error; do not retry blindly.
