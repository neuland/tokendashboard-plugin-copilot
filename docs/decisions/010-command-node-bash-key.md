# ADR-010: `command node` in the bash Hook Key (IntelliJ Compatibility)

## Decision
The **bash** key's hook command is prefixed with `command `:

```
command node "$HOME/.copilot/hooks/tokendashboard-plugin.js" --session-start
```

The **powershell** key and the cross-platform `command` fallback field keep bare `node` — this fix is bash-specific.

## Why
Under the JetBrains/IntelliJ Copilot CLI agent harness on macOS, the IntelliJ plugin (not Copilot itself, which runs the command via `bash --norc --noprofile -c` verbatim) rewrites a **leading** `node` token to an absolute path containing a space (`~/Library/Application Support/...`), passed unquoted. bash then word-splits it and fails to exec, with exit 127 — so the hook silently never runs under IntelliJ.

`command` as the leading token stops IntelliJ from rewriting it; `node` then resolves normally via PATH inside the `--norc --noprofile` shell (no aliases/functions loaded, but that shell already doesn't use them). This is a workaround for IntelliJ's rewrite, not a Copilot bug.

`removeOwnHooks` is unaffected — it matches the `HOOK_REF` path suffix, which the `command `-prefixed string still contains.

This does not fix capture of IntelliJ's own sessions — those still never write a `session.shutdown` event, so their token data remains uncapturable regardless of hook execution.

## Alternatives considered
- `exec` hook type: bypasses word-splitting, but needs an absolute Node path (undoing ADR-009's portability) and can't coexist with the `bash`/`powershell` keys.
- `which node`-based fallback: the command substitution is itself unquoted, so a spaced result reproduces the same word-split.
