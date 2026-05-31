---
name: canvas
description: Sync NUS Canvas course files and announcements into academic/<course>/canvas (read-only). Use when the operator asks to sync, refresh, or pull their Canvas materials.
---

# Canvas sync

Mirror the operator's active NUS Canvas courses into the hub.

Run from the hub root (or anywhere inside it):

```bash
node ${CLAUDE_SKILL_DIR}/scripts/sync.mjs
```

- Requires `CANVAS_API_TOKEN` in the environment (set in `~/.bashrc`); optional
  `CANVAS_BASE_URL` (default `https://canvas.nus.edu.sg`).
- Writes files + announcements into `academic/<course>/canvas/` (read-only,
  chmod 0444) and ensures a sibling `academic/<course>/user/` for working files.
- Idempotent: unchanged items are skipped via `academic/.canvas-manifest.json`,
  so re-running only fetches new/changed files.
- Optional `CANVAS_COURSES` (`;`-separated course codes or ids) limits the sync;
  empty syncs all active courses.

Report the printed summary line back to the operator.
