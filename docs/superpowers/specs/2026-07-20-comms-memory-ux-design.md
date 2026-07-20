# Comms pipeline, memory, and chat UX — design

Date: 2026-07-20
Status: approved design, pending implementation plan

## Context

Icarus is a daily driver. This round adds three shippable phases, in order:

- **Phase A — daily-driver polish:** stop button, photos as visual context, markdown memory
- **Phase B — mail pipeline:** daily Outlook `.pst` export → deep agent triage
- **Phase C — personal Telegram userbot + Google Calendar tools**

Guiding decision (approved "Approach 1"): all intelligence lives in agent turns with
purpose-built prompts; new TypeScript is plumbing only. No generic connector framework —
each source is a small bespoke module writing raw material into
`inbox/connectors/<name>/`, then enqueueing a triage turn through the existing queue.
The existing `connector_state` table supplies watermarks; a new `connector_items` table
supplies dedupe.

Cross-cutting requirement from the questionnaire: **outputs must get simpler and easier
to read.** A canonical digest style is part of this design, not an afterthought.

## Non-goals (roadmap, not this round)

- Canvas/academic connector (user has an API token; cheap future connector)
- Voice notes (dropped — no STT dependency wanted)
- Ambient noticing / idle reflection over files
- Morning briefing as a product (Phase C's calendar read tools quietly enable it later)
- Streaming partial replies; true mid-turn steering (stop button only)
- Sending messages from the user's personal Telegram account (userbot is read-only)

---

## Phase A — daily-driver polish

### A1. Stop button

- `TurnJob` (src/queue.ts) gains an `ac: AbortController` created in `submitTurn()`.
  `runner.ts` uses `job.ac` instead of its per-attempt internal controller (the hard-cap
  and idle timers call `job.ac.abort(reason)` as they do today).
- `queue.ts` exposes `abortRunning(): boolean` — aborts the currently running job, if any.
- Bot behavior (src/telegram/bot.ts): when an owner turn has been running for >10 s, send
  one message `working… ⏹ stop` with an inline button (`turn:stop`); delete that message
  when the turn ends. Quick replies never see it.
- Tapping ⏹ (or the new `/stop` command, which also covers scheduled-job turns) calls
  `abortRunning()`. The abort flows through the existing `status: 'aborted'` path — the
  user sees `(turn aborted: stopped by you)`.
- Messages sent during a running turn keep today's queue-and-coalesce behavior.

### A2. Photos join the conversation

- In the `bot.on('message')` handler: if the message contains a **photo**, save it to the
  inbox exactly as today, then skip the ingest/summarize/keep keyboard and immediately
  `submitOwnerText()` with the caption (or the default `Look at this image and respond.`)
  plus `(image: <savedPath>)`.
- No new capability needed: Claude Code's `Read` tool views images. The persona gains one
  line: always `Read` an `(image: …)` path before answering.
- Documents, audio, video, video notes keep the existing button flow.

### A3. Markdown memory

- New directory `wiki/memory/`:
  - `MEMORY.md` — index of one-liners pointing into topic files
  - topic files: `people.md`, `preferences.md`, and per-project notes as needed
- **Injection:** `contextHook.ts` injects the full text of `MEMORY.md` each turn inside a
  `<memory>` block, capped at 4 KB. Over the cap: truncate and append a warning line so
  the agent (and nightly consolidation) knows to prune. Reaches DM turns *and* fresh
  scheduled-job sessions, so recall survives `/clear`.
- **Writes:** persona instructs — when a turn surfaces something durable (fact, decision,
  preference, relationship), update the relevant topic file and, if a new topic appears,
  add an index line to `MEMORY.md`, in the same turn. Consult topic files when the index
  suggests relevance.
- **Consolidation:** a new *system* schedule `memory-consolidation` (nightly, separate
  from `reflection` so one failure cannot kill both) dedupes, merges, reorganizes topic
  files, and prunes stale entries. Its result DM is one line or silent.
- Memory is distinct from `record_feedback`: feedback is about how Icarus works; memory
  is about the user's life. The guard hook needs no change (wiki writes are allowed).

---

## Phase B — Outlook mail via `.pst` drop

### B1. Drop folder and parsing

- New env var `ICARUS_MAIL_DROP` — the folder where the daily `.pst` export lands
  (local or OneDrive-synced). Optional: mail pipeline is disabled when unset.
- A code-level croner job polls every 5 minutes (polling, not `fs.watch` — OneDrive sync
  makes watch events unreliable). A `.pst` is "ready" only when its size is stable across
  two consecutive checks (never read mid-sync).
- Parse in-process with `pst-extractor` (pure JS, no native deps).

### B2. Dedupe and raw storage

- Migration 2 (append to `MIGRATIONS` in src/db.ts):

  ```sql
  CREATE TABLE connector_items (
    source TEXT NOT NULL,
    item_id TEXT NOT NULL,
    processed_at TEXT NOT NULL,
    PRIMARY KEY (source, item_id)
  );
  ```

- Exports re-contain old mail, so `connector_items` records every message ever
  processed (keyed by stable message id); the `connector_state` watermark only narrows
  the scan window.
- Each new message becomes `inbox/connectors/mail/<date>/<n>-<subject-slug>.md`
  (from / to / date / subject header + body as text), attachments saved alongside. Raw
  mail stays greppable and wiki-linkable independent of triage.

### B3. Deep triage turn

- After a parse yielding new mail, enqueue one `job:mail-triage` turn — fresh session,
  generous cap (reuse `reflectionCapMs`-scale, 45 min).
- Prompt contract: read every new message file; discard spam/noise without comment; for
  anything real, *investigate* — follow links, use the browser for auth-walled or
  JS-heavy pages, read attachments and embedded images; extract deadlines, actions,
  amounts. Token cost is explicitly not a constraint.
- Output: **one digest DM** in the canonical digest style — urgent first, then a short
  "worth knowing" list, then one line counting what was discarded. Durable facts →
  memory (A3). Deadline-bearing items → calendar (C3); until C ships, native schedule
  nudges.

### B4. Browser access for triage jobs

- `runner.ts` sets `strictMcpConfig: true`, so externally configured MCP servers (the
  machine's Claude-in-Chrome setup) are invisible to sessions. The browser MCP server
  config is therefore declared in `config.ts` and passed **explicitly**, and only for
  triage jobs — DM turns stay lean. The concrete server command/args are copied from the
  machine's existing working Claude MCP config at implementation time. WebFetch is the
  documented fallback when the browser is unavailable.

### B5. Failure visibility

- Parse errors DM the owner (truncated) instead of dying in logs.
- If no fresh export has appeared for >36 h, send a one-line "mail export seems stalled"
  nudge (once per stall, not repeating daily).

---

## Phase C — personal Telegram + Google Calendar

### C1. Userbot plumbing

- gramJS MTProto client as `src/connectors/telegramUser.ts`, running in the same
  process. **Read-only** — it never sends as the user.
- Setup: `TG_API_ID`, `TG_API_HASH`, `TG_SESSION` in `.env`. One-time
  `npm run tg-login` (tsx script, interactive phone/code/2FA) prints the session string.
  All three optional: userbot disabled when unset.
- If the session dies or the client disconnects unrecoverably, DM the owner once.
- `/status` gains a connector-health block (last mail parse, userbot connected, last
  flush per chat) — the new moving parts must be visible.

### C2. Whitelist

- `/tg` command lists recent dialogs as inline toggle buttons; whitelist stored in the
  settings table (JSON list of chat ids + titles). Nothing outside the whitelist is ever
  read or stored.

### C3. Flow: burst-batch, then think

- The userbot buffers incoming messages per whitelisted chat and flushes after a
  5-minute quiet window or a 50-message cap, whichever first.
- Each flush: append raw messages to `inbox/connectors/telegram/<chat-slug>/<date>.md`;
  download media ≤20 MB alongside; serialize poll state (question, options, vote
  counts, close date, the user's own vote); mark items in `connector_items`; enqueue
  `job:tg-triage`.
- The triage turn sees the new batch plus recent chat-log context and decides: stay
  silent, DM an insight, or act — e.g. a poll converging on a date becomes a calendar
  entry plus a note on whether the user's vote matches the winner. Real-time-ish by
  design; batching prevents play-by-play narration.

### C4. Google Calendar via MCP server (revised 2026-07-20, post-ship, per Jeon)

- Originally shipped as native `googleapis`-backed tools; Jeon asked for the calendar
  MCP instead, so the native path (gcal.ts, `calendar_add_event`/`calendar_list_events`,
  `gcal-login`, the `googleapis` dependency) was removed.
- Wiring mirrors the browser MCP pattern: `ICARUS_CALENDAR_MCP` in `.env` holds a JSON
  `{command, args?, env?}` stdio server config, validated at boot. Unlike the browser
  (triage jobs only), the calendar server is attached to **every** turn (DM and jobs)
  as `mcpServers.calendar`, preserving the uniform-availability requirement.
- Optional: when unset, no server is attached and prompts that mention calendar tools
  say "if available this turn". Tool names are whatever the configured server exposes
  (`mcp__calendar__*`), so prompts reference calendar tools generically.

---

## Cross-cutting — canonical digest style

- One shared constant (`src/agent/digestStyle.ts`) defines the digest contract: urgent
  first; one item per line using `▸ label · value` lines; no headers or tables; hard
  length budget (~15 lines); "silence is a valid digest."
- Injected into both triage job prompts; referenced (not duplicated) by the persona.
- One new eval case (`evals/cases/digest-style.json`) locks the style so nightly
  reflection cannot drift away from it.

## Error handling summary

| Failure | Behavior |
|---|---|
| Turn aborted via ⏹ / `/stop` | existing `aborted` path; `(turn aborted: stopped by you)` |
| `MEMORY.md` over 4 KB | truncated injection + warning line; consolidation prunes |
| `.pst` mid-sync | size-stability check defers to next poll |
| `.pst` parse error | DM with truncated error |
| Export stalled >36 h | one nudge per stall |
| Userbot session dead | one DM; `/status` shows disconnected |
| Calendar not configured | tool returns readable error; agent says so |

## Testing

- `npm run typecheck` stays clean; `npm run selftest` extended to assert the
  `connector_items` table and print connector config state (mail drop set? userbot
  configured? calendar configured?).
- `npm run evals` gains `digest-style.json`.
- Manual smoke per phase: (A) long turn + ⏹; photo with/without caption; memory file
  written after telling it a durable fact; (B) drop a real export, verify raw files,
  digest, dedupe on second drop; (C) whitelist one chat, post in it, verify raw log +
  triage; create a test poll; add/list a calendar event from the DM.

## Delivery

Three phases land as three separate implementation plans, in order A → B → C. Each phase
is independently shippable and useful; later phases never block earlier ones.

## Known limitations and security posture (v1, recorded post-implementation)

- **Poll snapshots are post-time only.** The userbot serializes a poll when its message
  arrives; Telegram vote updates land as separate poll-update events that v1 does not
  subscribe to, so vote counts/leader marks are only populated when Telegram includes
  results in the message payload (e.g. closed or already-voted polls). Live "poll
  converging" detection needs an UpdateMessagePoll subscription — roadmap, not v1.
- **Prompt-injection posture: accepted for v1.** Mail bodies and whitelisted-chat text
  are third-party content, and triage turns run with the same bypassPermissions toolset
  as every other turn (guard hook protects the same three paths). This is a recorded,
  accepted risk for a single-user personal agent whose inputs are its owner's own
  mailbox and hand-whitelisted chats. Hardening options if it ever bites: strip Bash
  from `job:*-triage` turns, or a triage-specific guard profile. Revisit before adding
  any connector whose content the owner does not already trust.
