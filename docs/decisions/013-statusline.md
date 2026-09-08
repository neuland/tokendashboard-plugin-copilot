# ADR-013: statusLine Integration

## Decision
`statusline.js` is installed to `~/.copilot/tokendashboard-plugin/statusline.js`, listed in `pluginFiles` alongside `hook.js` (auto-updated via `converge()`), and registered as `settings.statusLine = { type: 'command', command: 'node "$HOME/.copilot/tokendashboard-plugin/statusline.js"' }`.

It reuses the plugin's own local state (`queue/`, `error.log`, `config.json`) for a sync/health indicator and version display, and reads Copilot's stdin payload directly for model name, context-window usage, token counts, and cost (`cost.total_nano_aiu / 1_000_000_000` = dollars) — with no hardcoded price table, since Copilot reports actual cost itself.

`installStatusLine`/`uninstallStatusLine` leave a pre-existing foreign `statusLine` (the user's own script, or another plugin's) untouched, matched by comparing against the installed `statusline.js`'s basename.

## Why
Copilot's `statusLine.command` payload is experimental and undocumented by GitHub (field shapes inferred from third-party writeups), so every field is read as optional — a missing `cost`, `context_window`, or `model` degrades to a zero/"Unknown model" default rather than throwing. If Copilot changes the payload shape, the statusline renders stale/zeroed numbers, not a crash.

Unlike Claude Code (which exposes no running total or cost, forcing the sibling `tokendashboard-plugin-claude` to reconstruct both from the transcript plus a hardcoded per-model price table), Copilot's payload already includes cumulative session totals and cost directly — so this plugin needs neither.
