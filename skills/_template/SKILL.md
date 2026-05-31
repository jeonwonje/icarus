---
name: SOURCE
description: TEMPLATE — copy this folder to skills/<source>/ and rewrite this line. Describe what the source is and when to sync it (e.g. "Sync <service> into <domain>/<subject>/<source>").
---

# <source> sync (template)

Copy this folder to `skills/<source>/`, then implement `scripts/sync.mjs`:

- Read credentials from the environment (set in `~/.bashrc`) — never store secrets
  in the hub (it syncs to the cloud) or in git.
- Resolve the hub root with `resolveHubDir` (walks up to the dir holding
  `.claude/` or `CLAUDE.md`).
- List items from the source, dedup against a manifest
  (`<hub>/<domain>/.<source>-manifest.json`), and write **only new/changed**
  items into `<hub>/<domain>/<subject>/<source>/`.
- Mark synced source files read-only (`chmod 0o444`); leave a sibling `user/`
  dir for the operator/agent.

Run it with:

```bash
node ${CLAUDE_SKILL_DIR}/scripts/sync.mjs
```

See `skills/canvas/scripts/sync.mjs` for a complete, dependency-free reference.
