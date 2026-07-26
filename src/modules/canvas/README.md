# canvas module

Polls Canvas LMS twice daily (08:00 and 18:00 in `ICARUS_TZ`), writes deltas to inbox, and enqueues a triage digest turn. `/canvas` forces an on-demand poll.

## Required env

- `CANVAS_BASE_URL` — school host, e.g. `https://school.instructure.com`
- `CANVAS_API_TOKEN` — personal access token from Canvas Account → Settings → New Access Token

Missing either fails boot. `--selftest` uses stub values.
