# ADR-012: hook.js as a Thin Loader, updater.js Fetched Fresh and Run via stdin

## Decision
`hook.js` contains no update logic beyond: throttle checks to once/24h (`onSessionStart`), fetch `updater.js` fresh from `repoRawBaseUrl` (`updateFromRemote`), and pipe it into a detached `node -` process with `TUP_MODE=converge` (`runUpdaterSource`) — nothing is written to disk. The throttle check itself runs detached because off-VPN DNS/TCP resolution to internal hosts can hang 20-30 seconds; `converge()` records `lastUpdateCheck` only once the update source is reachable, so a failed check (e.g. VPN off) is retried next session rather than waiting out the full 24h.

All version comparison, download/validation, atomic writes, locking, and `settings.json` patching live in `updater.js`'s `converge()`, which only runs inside that spawned `node -` process (guarded by checking `require.main` is absent) — never as a side effect of `require`-ing the module.

`hook.js`'s guard before running the fetched source is cheap (reject a body starting with `<!`, an HTML/captive-portal page) since the source is never written to disk — only piped to a child that will run it or fail to parse. `converge()`, by contrast, `vm`-compiles every `pluginFiles` payload (`isValidPayload`) before writing it to disk as `hook.js`/`statusline.js`, since those files persist and a broken write is unrecoverable without a manual reinstall.

## Why
- Anything frozen in the durable payload can only be fixed by a manual reinstall, so update logic must not live there — fetching `updater.js` fresh on every check means a bug fix there takes effect on the very next scheduled check, not the next manual reinstall.
- `updater.js` itself is still never auto-updated — only a manual `npx` re-run picks up a new `updater.js`. Only `pluginFiles` entries (`hook.js`, `statusline.js`) are durable and auto-updated.
