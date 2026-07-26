# mail module

Watches `ICARUS_MAIL_DROP` every five minutes for stable Outlook `.pst` exports, extracts new messages to inbox, and enqueues a mail-triage digest turn.

## Required env

- `ICARUS_MAIL_DROP` — folder where daily Outlook `.pst` exports land

Missing it fails boot. `--selftest` uses `state/selftest-mail-drop` under the repo.
