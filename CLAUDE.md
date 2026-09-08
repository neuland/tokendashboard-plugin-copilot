# tokendashboard-plugin-copilot

GitHub Copilot CLI hook plugin that captures token usage per model and forwards it to an internal HTTP endpoint. Handles offline scenarios (VPN not active) via a local store-and-forward queue. Silently checks for updates on session start and fetches+applies them in the background; also ships a `statusLine` script showing model, context usage, sync health, and cost.

## Files

| File | Purpose |
|---|---|
| `hook.js` | Durable payload (installed + auto-updated). Capture/flush/sweep plus a minimal update loader. Modes: `--session-start`, `--session-end`, `--sweep`, `--flush`, `--capture`, `--update` (fetch+run `updater.js`). |
| `updater.js` | All lifecycle logic: `install`/`uninstall` (the `npx` `bin` entry, includes statusline install/uninstall) and `converge` (fetched fresh, run via stdin — see ADR-012). **Not** a durable file — never installed to disk. |
| `statusline.js` | `statusLine` command script. Reads the plugin's own queue/error-log state plus Copilot's experimental stdin payload (model, context window, cost) to render a status line. Self-contained — does not `require('./hook.js')` or `updater.js` (see ADR-013) — but is still a `pluginFiles` entry, auto-updated like `hook.js`. |
| `package.json` | Package manifest. Bump `version` to trigger auto-update rollout; `pluginFiles` lists durable auto-updated payload files (`hook.js`, `statusline.js`). |
| `docs/decisions/` | Architecture Decision Records (ADRs). |

## Architecture

Two hooks registered in `~/.copilot/settings.json`:

| Hook | Command | Purpose |
|---|---|---|
| `sessionStart` | `node hook.js --session-start` | Spawn background `--sweep` (capture previous sessions + flush) + update check (once/24h) |
| `sessionEnd` | `node hook.js --session-end` | Spawn a detached `--capture <session-id>` (poll for the shutdown event, capture, then flush) |

`--update` fetches `updater.js` fresh from the configured `repoRawBaseUrl` and runs it via `node -` (stdin, `TUP_MODE=converge`); the updater's `converge()` downloads any changed `pluginFiles`, validates the payload (`isValidPayload`, a `vm.Script` parse check) before writing it, and repoints `settings.json` (hooks + `statusLine`) on drift. See ADR-012.

A `statusLine` entry is also registered in `~/.copilot/settings.json`, pointing at the installed `statusline.js` (see ADR-013).

Copilot does not give hooks per-turn transcript data (as Claude Code does). Token
totals live only in the `session.shutdown` event of
`~/.copilot/session-state/<session-id>/events.jsonl`, so capture reads that file. A
session writes **at most one `session.shutdown`**, even across many prompts and a
`/resume` (see README's "Known limitation: resumed sessions under-report usage" —
observed sessions never write a second one). Copilot writes `session.shutdown` a
moment *after* the `sessionEnd` hook returns (observed ~30ms later), and it fires
`sessionStart` only on the first prompt of a new session — not at launch. So
`sessionEnd` does **not** capture inline; it spawns a detached `--capture` process
that polls `events.jsonl` for the shutdown
event (up to `POLL_TIMEOUT_MS`) and then flushes, surviving Copilot's exit via `unref`.
This sends the just-ended session promptly instead of waiting for the next session's
sweep, which remains the backstop for SIGKILL/crash sessions (see ADR-008).

Local files written by the plugin:

| Path | Purpose |
|---|---|
| `~/.copilot/hooks/tokendashboard-plugin.js` | Installed hook script (auto-updated via `pluginFiles`) |
| `~/.copilot/tokendashboard-plugin/statusline.js` | Installed statusline script (auto-updated via `pluginFiles`, like the hook) |
| `~/.copilot/tokendashboard-plugin/update.lock` | Serializes concurrent `converge()` runs (separate from the flush queue's own lock) |
| `~/.copilot/tokendashboard-plugin/config.json` | `currentVersion` + `lastUpdateCheck` timestamp |
| `~/.copilot/tokendashboard-plugin/user-id` | Random UUID for user pseudonymization |
| `~/.copilot/tokendashboard-plugin/queue/` | Per-entry queue files (`[timestamp]-[pid]-[counter].json`) |
| `~/.copilot/tokendashboard-plugin/captured/` | Per-session presence markers (`<session-id>`) so a session's single `session.shutdown` is queued exactly once |
| `~/.copilot/tokendashboard-plugin/capture-locks/` | Per-session locks (`<session-id>`) serializing concurrent capture so a session is queued exactly once |
| `~/.copilot/tokendashboard-plugin/skipped/` | Processed checkpoints (`<session-id>` → `{mtimeMs,size}`) for every swept session (captured or not), so the sweep stops re-reading a file until it changes — a late-appended shutdown grows the file and forces a re-read |
| `~/.copilot/tokendashboard-plugin/dead-letter/` | Queue entries the server permanently rejected (400/422) — quarantined here so they stop blocking the queue, kept for inspection |

## Code style

After editing any source file (`hook.js`, `updater.js`), both the linter and the unit tests must pass before the change is considered done:

```bash
npm run lint
npm test
```

All ESLint errors must be resolved and all unit tests must pass — no exceptions.

## Testing

Tests use the built-in `node:test` runner (no extra dependency). Run with:

```bash
npm test
```

Conventions:

- Structure every test with `// given`, `// when`, `// then` comments marking the three phases. When a test is a series of one-line assertions where each line is itself given+when+then (e.g. table-style checks), collapse them under a single combined comment instead of splitting artificially.
- Because the plugin writes into `~/.copilot/*` via constants derived from `os.homedir()` at load time, fs-touching tests run inside an isolated temp `$HOME`. Use `inSandbox`/`inSandboxAsync` (for `hook.js`), `inCliSandbox`/`inCliSandboxAsync` (for `updater.js`), or `loadStatusline` (for `statusline.js`) from `test/helpers.js` — each redirects `$HOME`, loads a fresh module, and guarantees cleanup. Use `writeSession(home, id, { shutdownData })` to fabricate session-state. Prefer real temp dirs over mocking `fs`.
- `hook.js` only runs `main()` under `require.main === module`, so it is safe to `require` in tests; all testable functions are exported at the bottom. `onSessionStart`/`onSessionEnd` take a `spawnFn` seam so spawning can be asserted without launching processes. `updater.js`'s `converge()` only auto-runs when `require.main` is absent AND `TUP_MODE=converge` is set (the fetched-stdin-run case) — calling `cli.converge()` directly in a test is safe and does not require setting that env var.

## Critical constraints

- **Do not change the queue to a single file.** Per-file pattern is required for concurrency safety (see ADR-004).
- **Do not flush per turn.** Flush runs in the background on session start/end, not on every turn (see ADR-003, ADR-005).
- **Queue writes are atomic.** `writeEntry` uses `atomicWriteSync` (tmp + rename), not a plain `writeFileSync` — a concurrent flush snapshots the queue dir and deletes the snapshot on success, so a half-written file in that listing would be read as corrupt and then deleted, losing the entry (see ADR-005).
- **Flush batches and dead-letters.** Entries are sent in batches of `FLUSH_BATCH_SIZE` so a long offline backlog never produces one oversized body. Delivery requires a *genuine* ingest success (`isIngestSuccess`): a 2xx that was not redirected and is not an HTML body — an off-VPN captive portal answering 200-HTML or a followed redirect must not be mistaken for success, or queued entries are silently lost. Transient failures (no response, 5xx, 408, 429, proxy/auth 401/403/407, a 404/405 from a momentarily-undeployed endpoint, or a non-genuine 2xx — everything except a genuine content rejection, see `isRetryable`) leave entries queued for the next flush; only a permanent 400/422 is dead-lettered. To avoid one poison entry quarantining its whole batch, a permanently-rejected batch is **bisected** (`deliverBatch`) and each half retried, so only the offending entry reaches `dead-letter/` (see ADR-005).
- **Lock files** — the flush queue (`queue/.lock`, in `hook.js`) and the updater (`update.lock`, in `updater.js`'s `acquireUpdateLock`/`releaseUpdateLock`) each use the same stale-PID-steal pattern and must always be released in a `finally` block. Stale locks (owning process dead) are automatically stolen on next acquire. `converge()` is lock-guarded because concurrent sessions can spawn overlapping `--update` runs (see ADR-012).
- **Atomic rename** for pluginFiles downloads and `settings.json` writes: write to a **PID-namespaced** `.tmp` first, then `fs.renameSync` — a shared temp name lets concurrent writers rename a half-written file (see ADR-012). `updater.js` itself is never written to disk during an update — it is piped into a `node -` child process via stdin and never persisted (see ADR-012).
- **`--api-base-url <url>` and `--repo-raw-base-url <url>` are both required on every install/reinstall**, parsed/validated in `updater.js`'s `main()`, with **no fallback to a previously stored `config.json` value and no hardcoded default anywhere in source** (see ADR-011). `--api-base-url` is stored as `apiBaseUrl` — the bare base URL of the backend (e.g. `https://tokendashboard.example.com`), not a full endpoint URL. `flush()` reads it from there, appends the fixed ingest path (`INGEST_PATH`, `/api/usage/ingest/copilot`) via `hook.js`'s `ingestUrl()` helper, and refuses to send (keeping the queue) when `apiBaseUrl` is absent. `--repo-raw-base-url` is stored as `repoRawBaseUrl`; both `hook.js`'s `updateFromRemote` (to fetch `updater.js`) and `updater.js`'s `converge()` (to fetch `package.json`/`pluginFiles`) read `loadConfig().repoRawBaseUrl` directly (no fallback constant) and build each raw-file URL via the trailing-slash-safe `rawUrl(base, file)` helper (duplicated in both files, deliberately — see ADR-012) — if it is absent (e.g. an install predating this requirement), both treat that exactly like "not installed" and no-op, never fetching or touching an installed file. The value stored/passed is the raw-file **base URL** directly (e.g. GitLab's `.../-/raw/main`, GitHub's `raw.githubusercontent.com/<org>/<repo>/main`) — not the repo URL itself — so no host-detection logic is needed. `install()` writes exactly what was passed (validated non-empty by `main()`), never merging with an existing config value. `deliverBatch`'s recursive bisection takes the fully-built ingest `url` as a parameter (rather than closing over a module constant) so every retried half still posts to it. `isPlausibleUrl(value, requirePath)` validates both flags but with different rules: `--repo-raw-base-url` requires a path (`requirePath: true`, the default — it names a specific raw-files root); `--api-base-url` does not (`requirePath: false` — a bare origin is the valid form, since the plugin appends its own path).
- **Only `pluginFiles` entries (`hook.js`, `statusline.js`) are auto-updated.** `updater.js` and `package.json` require a manual `npx` re-run — see ADR-012, ADR-013.
- **Version bump on user-facing changes.** When changes to `hook.js`, `updater.js`, or `statusline.js` require users to get the update (new payload fields, behavior changes, bug fixes), bump `version` in `package.json`. This triggers the auto-update rollout (for `pluginFiles` entries) on the next user session's `converge()`.
- **Price is read from Copilot, never hardcoded.** `statusline.js` computes cost as `cost.total_nano_aiu / 1_000_000_000` (dollars) straight from Copilot's own stdin payload — do not reintroduce a per-model price table (the claude plugin needs one only because Claude Code exposes no cost figure; Copilot does).
- **One entry per model, per shutdown.** When a session's `session.shutdown` is captured, `captureSession` (via `writeShutdownEntries`) iterates its `data.modelMetrics` and writes one queue entry per model, so a mid-session model switch is not collapsed. A session yields at most one shutdown, hence at most one such batch of entries over its life (see ADR-007; an earlier per-prompt-counting design was reverted — Copilot never wrote more than one). The `writeCounter` in the queue filename prevents same-millisecond collisions across those writes (see ADR-003).
- **`captured/` markers** dedupe capture across the `sessionEnd` poller and the `sessionStart` sweep — never remove them. Presence is checked before capture and written after, so concurrent captures (a `sessionEnd` racing a sweep, or two parallel sweeps) could both write entries and double-capture. `captureSession` therefore wraps the whole check → `writeEntry` → `markCaptured` critical section in a **per-session lock** (`capture-locks/<session-id>`); a crashed holder leaves the session unmarked and is recovered on a later sweep via stale-lock stealing. Do not move entry writes outside that lock (see ADR-007).
- **Sweep efficiency (see ADR-007).** `findShutdownEvent` reads only the tail (`TAIL_BYTES`) to find the session's one shutdown; this is gated by `(mtime,size)` processed-checkpoints in `skipped/` — recorded for **every** swept session (captured or not) — so an unchanged file is never re-read, and the sweep prunes orphan markers each run. The check is stat-based, not time-based, so a late-appended shutdown is never lost — keep it that way.

## Install / Uninstall

```bash
npx git+https://github.com/neuland/tokendashboard-plugin-copilot.git install --api-base-url <url> --repo-raw-base-url <url>
npx git+https://github.com/neuland/tokendashboard-plugin-copilot.git uninstall
```

Both `--api-base-url <url>` (or `--api-base-url=<url>`) and `--repo-raw-base-url <url>` (or `--repo-raw-base-url=<url>`) are required on every install/reinstall — there is no hardcoded default for either, and neither is read back from a previously stored `config.json` value.
