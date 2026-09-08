# ADR-003: Session-Based Capture (sessionEnd + sessionStart Sweep)

## Decision
- **`sessionEnd`** spawns a detached `--capture` that polls for the `session.shutdown` event, writes one queue entry per model, then flushes (see ADR-008).
- **`sessionStart`** spawns a detached sweep + flush + update check: captures any shutdown not yet queued from previous sessions, then flushes.

Capture is per `session.shutdown` event; a session produces at most one (see ADR-007).

## Why
- Copilot CLI hooks do not expose per-turn token data. Aggregated totals (per model, including cache/reasoning tokens) appear only in the `session.shutdown` event written to `~/.copilot/session-state/<id>/events.jsonl`.
- `session.shutdown` is written a moment *after* the `sessionEnd` hook returns, so `sessionEnd` cannot read it inline — it must poll in a detached process (ADR-008).
- Copilot fires `sessionStart` only on the first prompt of a new session, not at launch — so the sweep is the backstop for shutdowns a killed/crashed poller missed, not a substitute for the poller.
- Flushing only on session start/end (not every turn) avoids a network round-trip (and its timeout) on every turn.
- `sessionEnd` does not fire on `kill -9`, and a hard crash mid-session may leave `session.shutdown` never written; either way that session's shutdown is picked up (or permanently missed) via the next sweep, not retried indefinitely.
