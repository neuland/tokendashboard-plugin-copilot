# ADR-009: $HOME-Relative Hook Command

## Decision
The hook command written into `settings.json` references the hook via `$HOME`, not an absolute path:

```
node "$HOME/.copilot/hooks/tokendashboard-plugin.js" --session-start
```

`HOOK_REF` is the single source of truth: `updater.js` derives both the filesystem install destination and this command string from it. `removeOwnHooks` matches on the `.copilot/hooks/tokendashboard-plugin.js` suffix (not a full path), so it recognizes both this form and any legacy absolute-path install.

## Why
- An absolute path baked at install time (e.g. `/Users/alice/.copilot/...`) breaks under a devcontainer that mounts the host's `~/.copilot` at a different path (e.g. `/home/<user>/...`) — Copilot fires the hook with a path that doesn't exist in the container, and it silently never runs.
- Copilot runs hook commands through a shell, so `$HOME` expands at fire time to whichever environment (host or container) is currently running.
- PowerShell Core also defines `$HOME` and accepts forward slashes, so one string works for both the `bash` and `powershell` keys and the `command` fallback — no per-shell branching needed.
- `converge()` repoints `settings.json` (hooks + `statusLine`) on drift (see ADR-013), so this form is what gets written on both fresh installs and future auto-corrections — not only at initial `npx install` time.

## Alternatives considered
`${COPILOT_HOME:-$HOME/.copilot}` would also honor `COPILOT_HOME` relocation, but `${VAR:-default}` is bash-only syntax with no PowerShell equivalent — would break the single-string design.
