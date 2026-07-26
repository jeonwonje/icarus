# tg-archive module

Personal Telegram archive via GramJS: live sync, historical import, project mapping, `/tg` and `/archive` bot UI, and MCP search tools.

## Required env

- `TG_API_ID` — Telegram API application id from [my.telegram.org](https://my.telegram.org)
- `TG_API_HASH` — Telegram API application hash
- `TG_SESSION` — GramJS string session (created via `npm run tg-setup`)

Missing any fails boot. `--selftest` uses stub values.

## Schedules

- `tg-project-sweep` — Monday 09:00; runs historical pass and notifies pending project-mapping proposals

## MCP tools

- `archive_search` — full-text search over archived messages
- `archive_window` — conversation window around one message

Archive files live under kernel `cfg.telegramArchiveDir` (`archive/telegram/` in the repo).
