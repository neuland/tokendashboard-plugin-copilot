# ADR-002: Distribution via npx and Git

## Decision
Distributed as an npm package via `npx` pointed at the repo's Git URL:

```bash
npx git+https://github.com/neuland/tokendashboard-plugin-copilot.git install --api-base-url <url> --repo-raw-base-url <url>
```

`updater.js` is the `bin` entry in `package.json` and handles install/uninstall, patching `~/.copilot/settings.json` idempotently (safe to re-run).

## Why
- Single command for install/uninstall; no manual `settings.json` editing.
- Requires only Git access to the repo, not a package registry.
- `updater.js`/`package.json` changes require re-running `npx`; `hook.js` (and `statusline.js`) auto-update on their own (see ADR-012).

## Alternatives considered
- Manual `settings.json` editing: too error-prone for end users.
- Git-host npm registry: needs one-time per-machine registry config; extra infra.
- Shell script via curl: less trustworthy, harder to version.
