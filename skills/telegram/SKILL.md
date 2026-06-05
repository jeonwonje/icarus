---
name: telegram
description: Archive all Telegram chats locally (DMs, groups, channels) and distill new activity into per-chat digests in telegram/. Use when the operator asks to sync, refresh, pull, or catch up on their Telegram.
---

# Telegram second-brain ingest

Maintain a local archive of the operator's Telegram and keep per-chat **digests**
in the hub current. Unlike canvas/outlook, this skill needs `npm install` once
(it depends on GramJS — see CLAUDE.md).

## 0. One-time setup

1. Create an app at https://my.telegram.org → API development tools.
2. In `~/.bashrc`: `export TELEGRAM_API_ID=…` and `export TELEGRAM_API_HASH=…`.
3. `node ${CLAUDE_SKILL_DIR}/scripts/login.mjs` → follow prompts → paste the
   printed `export TELEGRAM_SESSION=…` into `~/.bashrc`, then `source ~/.bashrc`.

## 1. Run the ingester

```bash
node ${CLAUDE_SKILL_DIR}/scripts/sync.mjs
```

- Reads `TELEGRAM_API_ID/HASH/SESSION` from the environment (never the hub).
- Archives messages + media to `${TELEGRAM_ARCHIVE_DIR:-/mnt/c/Users/jeonw/Desktop/telegram-chats}`
  (local-only, outside OneDrive). Media capped by `${TELEGRAM_FILE_MAX_MB:-100}`.
- Incremental: only fetches messages newer than the per-dialog cursor. First run
  archives everything silently and seeds the delta with the last
  `${TELEGRAM_DIGEST_DAYS:-30}` days only.
- Emits `delta/latest.json`. Report the printed summary line to the operator.

## 2. Curate the digests

Read `<archive>/delta/latest.json`. It is grouped by chat (`chats[].records`).
For each chat with new activity, open or create its digest —
`<hub>/telegram/dms/<slug>.md` (DMs) or `<hub>/telegram/groups/<slug>.md`
(groups/channels) — and update these sections, inferring meaning across
fragmented, sloppily-typed messages:

- **Summary** — rolling narrative of the relationship/thread.
- **Open threads** — unanswered questions, undecided things.
- **Action items** — what the operator owes, what they're waiting on, deadlines.
- **Key facts** — durable details (addresses, decisions, plans, preferences).

Then surface only genuinely actionable items (someone awaiting a reply, a dated
commitment) into `<hub>/index.md` under `## Telegram` — one line per chat, dedup
against existing entries. Routine chatter stays in the per-chat digest.

After digesting a chat, set `lastDigestedId` for that dialog in
`<archive>/.telegram-manifest.json` to its highest delta record id, so the next
run's delta starts clean. Keep digests tight — they are a curated surface, not a
transcript.
