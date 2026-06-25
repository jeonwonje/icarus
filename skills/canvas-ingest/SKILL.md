---
name: canvas-ingest
description: Pull the latest Canvas course files into the hub. Use when the user asks to refresh, sync, or update Canvas, or asks about course material that may be out of date.
---

# Canvas ingest

When the user asks to refresh Canvas (or you need newer course material than what
is in `raw/canvas/`), run this command from the hub:

```bash
node "$ICARUS_HOME/dist/ingest/canvas.js"
```

(If `dist/` is absent because the service is running from source, use
`npx --prefix "$ICARUS_HOME" tsx "$ICARUS_HOME/src/ingest/canvas.ts"` instead.)

This writes read-only mirrors under `raw/canvas/<course>/`, filtered by the
course allowlist in `$ICARUS_HOME/sources.config.json`. It prints a summary line.

After it finishes, the new files appear in `<new_sources>` on your next turn —
file them into `wiki/` and update `index.md`, citing each `raw/canvas/...` path.
Report what was pulled. If the command fails, report the error to the user; do
not retry blindly.
