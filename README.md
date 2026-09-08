# tokendashboard-plugin-copilot

GitHub Copilot CLI hook plugin that captures token usage per model and forwards it to an internal HTTP endpoint.

## Features

- Captures input/output, cache and reasoning tokens per session and model from Copilot's `session.shutdown` event
- Pseudonymizes users via a local random UUID — no prompt or file content is transmitted, only token/cost usage linked to that UUID and a session id
- Store-and-forward queue: entries survive offline periods (e.g. VPN not active) and are sent on the next session
- Auto-updates `hook.js` and `statusline.js` silently in the background once per 24 hours by fetching and executing `updater.js` from the configured `--repo-raw-base-url` (
  see [Security](#security))

## Install

```bash
npx git+https://github.com/neuland/tokendashboard-plugin-copilot.git install --api-base-url https://example.com --repo-raw-base-url https://raw.githubusercontent.com/neuland/tokendashboard-plugin-copilot/main
```

Both flags are required on every install/reinstall — neither has a built-in default:

- `--api-base-url <url>` — the base URL of the backend that receives usage data (e.g. `https://example.com`). The plugin appends its own ingest path (`/api/usage/ingest/copilot`)
  to it.
- `--repo-raw-base-url <url>` — the raw-file base URL the plugin auto-updates from (e.g. `https://raw.githubusercontent.com/<org>/<repo>/main` for a GitHub fork, or
  `https://gitlab.example.com/<org>/<repo>/-/raw/main` for a GitLab one).

Neither value is read back from a previous `config.json` — pass both again on every reinstall.

## Uninstall

```bash
npx git+https://github.com/neuland/tokendashboard-plugin-copilot.git uninstall
```

## How it works

Two hooks are registered in `~/.copilot/settings.json`:

| Hook           | Purpose                                                                                                                                    |
|----------------|--------------------------------------------------------------------------------------------------------------------------------------------|
| `sessionStart` | Spawns a background sweep (captures previous sessions + flushes the queue) and checks for updates once per 24h                             |
| `sessionEnd`   | Spawns a detached background process that polls for the session's `session.shutdown` event, captures it into the local queue, then flushes |

Unlike Claude Code, Copilot does not expose per-turn transcript data to hooks. Token
totals are only available in the `session.shutdown` event written to
`~/.copilot/session-state/<session-id>/events.jsonl`. The plugin therefore captures
per session, not per turn. Copilot writes that event a moment *after* the `sessionEnd`
hook returns, so capture runs in a detached process that waits for it (surviving
Copilot's exit) rather than reading once and giving up. The `sessionStart` sweep
remains the backstop for sessions that ended via Ctrl+C / crash with no shutdown
written.

The payload sent to `<api-base-url>/api/usage/ingest/copilot`:

```json
{
  "user_id": "<random-uuid>",
  "prompts": [
    {
      "timestamp": "2026-06-09T11:32:23.530Z",
      "session_id": "...",
      "model": "gpt-5.4-mini",
      "usage": {
        "input_tokens": 76668,
        "output_tokens": 13366,
        "cache_read_tokens": 739840,
        "cache_write_tokens": 0,
        "reasoning_tokens": 9773
      },
      "requests": 31,
      "total_nano_aiu": 17313600000,
      "total_premium_requests": 2.97
    }
  ]
}
```

One entry is written per model — a session that switched models mid-run produces one
entry per model.

## Known limitation: resumed sessions under-report usage

This plugin's capture logic is built around Copilot's `session.shutdown` event
(see [How it works](#how-it-works)). For a session that is **resumed** — reopened
and continued rather than started fresh — Copilot CLI does not write a new
`session.shutdown` for subsequent prompts. In an observed real session
(Copilot CLI 1.0.82, ~65 minutes, 8+ prompts against `gpt-5.4`), exactly **one**
`session.shutdown` was written near the start of the session, followed by a
`session.resume` and normal activity through to the end — with **no second
`session.shutdown`** anywhere in the rest of the session. This was not just a
missed edge case: multiple `exit`s were tried during that same session, and
none of them produced a second `session.shutdown`/`session.resume` pair in the
file either. So this isn't "you can work around it by exiting properly" — under
repeated, real interactive use the gap did not close even once. Treat it as
unconditional, not something a workaround avoids.

Since capture only fires on `session.shutdown`, everything after the first one
in a resumed session is missed — silently, with no error and no log entry.
Measured on that session: the captured entry reported 35.7B of an eventual 234.0B
`totalNanoAiu` (**~15% of actual cost captured, ~85% missed**) and 1 of 9
`totalPremiumRequests` (**~89% missed**). Whether this matters for you depends on
your usage pattern: if you mostly run your sessions once, this rarely bites;
if you frequently resume long-running sessions across many prompts, the reported
numbers can be a small fraction of your real usage.

**Why this isn't a quick fix.** Copilot does expose other events with
per-session/per-call usage data, but none of them are a drop-in replacement:

- `session.usage_checkpoint` fires repeatedly during a session and carries
  growing cumulative totals (`totalNanoAiu`, `totalPremiumRequests`) plus
  per-model `prompt_tokens`/`cache_read` — but it has no equivalent for
  `output_tokens`, `reasoning_tokens`, or a request count in the shape this
  plugin's payload currently uses. Building on it means either shipping a
  reduced field set for interim entries, or accepting an approximation.
- `model.model_call_success` carries richer per-call token accounting, but in
  the observed session it only ever fired for auxiliary/internal calls (a
  `gpt-5.4-nano` "frustration detector" run after each message, a `gpt-4o-mini`
  session-title generator) — never for the actual interactive model
  (`gpt-5.4` over `ws:/responses`). It cannot fill the gap for the model that
  matters.
- Even a correct client-side fix depends on a **backend change that's outside
  this repo's control**: see the next section — the backend currently assumes
  each session is sent exactly once and deduplicates on `session_id` alone. A
  fix that sends interim/delta updates as a session progresses would have every
  update after the first silently discarded by that dedup rule unless the
  backend's conflict key is widened first (and Copilot's checkpoint data has no
  natural per-prompt id to widen it with, beyond an untested `request_id`/
  `model_call_id` inside `promptCacheBreakState` that doesn't obviously cover
  the main interactive model either).

In short: this is a real, measured gap, not a hypothetical one — but closing it
requires both a genuinely different capture strategy in this plugin and a
coordinated change to the backend's dedup key, not a local patch. If your usage
pattern makes this significant for you, that's the scope to budget for.

## Backend dependency: sessions must be sent exactly once

This plugin currently sends each session as a single, session-aggregated cumulative report — 
one POST per session, containing that session's running totals. The backend relies on this 
as a hard invariant: it deduplicates incoming Copilot records on session_id alone 
(ON CONFLICT (session_id) DO NOTHING), unlike the Claude and OpenCode plugins, 
which dedupe on (session_id, prompt_id) because those plugins report individual
prompts with their own ids.

The narrow key is safe only because this plugin never re-sends an already-reported session. 
Copilot's payload has no per-prompt id — only session_id, requests, and total_nano_aiu —
so the backend has no finer key to fall back on even if it wanted one.

If this plugin is ever changed to re-send an open session with updated cumulative totals, 
that will silently corrupt backend data. The backend's ON CONFLICT (session_id) DO NOTHING
will discard the update entirely — no error, a normal success response — and that session's 
usage will stay frozen at whatever was first reported. Nothing on the backend will surface this; 
it will just look like the session's usage stopped growing.

Before changing this plugin's send behavior to re-send sessions, the backend's conflict key 
must be widened to (session_id, prompt_id) first, and this plugin's payload would need a
per-prompt id to make that possible. Coordinate with the backend maintainer before making 
that change here.

(Backend-side reference: docs/decisions.md #13 in the TokenDashboard repo.)

## Security

Beyond sending usage data to your own `--api-base-url`, this plugin **auto-updates
itself by fetching and executing code**: once per 24 hours it downloads `updater.js`
from your configured `--repo-raw-base-url` and runs it via `node -` (piped over
stdin, never written to disk), which in turn may download and replace `hook.js` and
`statusline.js`. This is by design (see `docs/decisions/` for the ADRs behind it),
transport is HTTPS-only (a bare `http://` URL is rejected unless it points at
`localhost`/`127.0.0.1`/`::1`), and a redirected response is never accepted. There is
currently no additional signature or checksum pinning beyond that — the trust
boundary is whoever controls the raw-file host you pass to `--repo-raw-base-url`.
By default that's this repository's `main` branch, maintained by neuland — using it
means trusting that we (and anyone whose PR we merge) never point it at a different
endpoint or ship malicious code. If you'd rather not extend that trust, point
`--repo-raw-base-url` at a fork you control instead — you'll then need to keep it in
sync yourself. See [SECURITY.md](SECURITY.md) for how to report a vulnerability.

## Troubleshooting

The `statusLine` shows a red dot with "exception — see exceptions.txt" when
`~/.copilot/tokendashboard-plugin/exceptions.txt` is non-empty. This file is reserved for
conditions that should never happen (unlike ordinary connectivity errors, which are
retried automatically and don't need attention) — if it's non-empty, usage data is
being silently dropped. To resolve: open the file, read what it says, fix the
underlying cause, then clear it (delete the file or empty its contents). The red dot
clears as soon as the file is empty again.

## Development

```bash
node updater.js install --api-base-url <url> --repo-raw-base-url <url>  # install the plugin into ~/.copilot/ and register the hooks in ~/.copilot/settings.json
npm run unregister  # remove the hook and its registration
npm run lint        # run ESLint
npm test            # run the unit tests
```
