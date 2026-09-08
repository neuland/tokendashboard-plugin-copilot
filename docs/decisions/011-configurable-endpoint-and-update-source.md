# ADR-011: Configurable, Required Ingest Endpoint and Update Source

## Decision
Two install-time CLI flags on `updater.js`'s `bin` entry, **required on every install/reinstall**, stored in `config.json`, and **never read back from a previously stored value** (omitting either on a re-run is a hard error, not a silent reuse):

- `--api-base-url <url>` — base URL of the backend that receives usage data (e.g. `https://tokendashboard.example.com`). Stored as `apiBaseUrl`; `flush()` appends the fixed ingest path (`/api/usage/ingest/copilot`, via `ingestUrl()`) and refuses to send (keeping the queue) if `apiBaseUrl` is absent.
- `--repo-raw-base-url <url>` — the raw-file base URL the plugin auto-updates from. Stored as `repoRawBaseUrl`; both `hook.js` (fetching `updater.js`) and `updater.js`'s `converge()` (fetching `package.json`/`pluginFiles`) read it directly with no fallback constant, building each URL via the trailing-slash-safe `rawUrl(base, file)` helper. Absent (e.g. a pre-ADR-011 install) is treated exactly like "not installed" — no fetch, no touch.

`isPlausibleUrl(value, requirePath)` validates both, with different rules: `--repo-raw-base-url` requires a path (it names a specific raw-files root); `--api-base-url` does not (a bare origin is valid — the plugin appends its own route).

`deliverBatch`'s bisection takes the fully-built ingest URL as an explicit parameter, not a module constant, so every retried half still posts correctly.

## Why
- The ingest backend is deployment-specific — there is no sane shared default across forks/installs.
- GitLab's `/-/raw/main/<file>` and GitHub's `raw.githubusercontent.com/<org>/<repo>/main/<file>` have no common derivation from a single repo URL, so auto-detecting the raw-file shape from a plain URL is unbounded host-sniffing for no real benefit. Passing the raw-file base URL directly needs no host detection at all.
- A hardcoded default (even pointing at this project's own repo) silently ties every fork to this project's update stream unless explicitly overridden, and goes stale the moment this repo's own host changes. Requiring the flag with no default and no read-back makes the update source a conscious choice on every install.

## Alternatives considered
Environment variables instead of flags — rejected, since `npx git+<url>.git install` is typically one-shot and an env var is less discoverable than a documented flag.
