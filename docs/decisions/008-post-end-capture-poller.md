# ADR-008: Detached Post-End Capture Poller

## Decision
`onSessionEnd` does no capture itself. It spawns `--capture <session-id>` as a detached background process (`spawnBackground`, `detached: true`, `unref()`), which runs `captureWithPoll`: loop `captureSession` until it succeeds or `POLL_TIMEOUT_MS` (30s) elapses, sleeping `POLL_INTERVAL_MS` (1s) between attempts. `flush()` runs afterward regardless of whether a shutdown was found.

The `sessionStart` sweep remains the backstop for sessions that never write a shutdown (SIGKILL/crash) or whose poller was itself killed.

## Why
- Copilot writes `session.shutdown` to `events.jsonl` *after* the `sessionEnd` hook returns — an inline read in the hook consistently finds nothing yet.
- Copilot fires `sessionStart` only on the first prompt of the *next* session, not at launch — without this poller, a session's data is only sent once the user starts and prompts another session, and the user's last-ever session is never sent at all.
- The poller must be detached so `sessionEnd` returns immediately and Copilot's teardown is never blocked; the child is its own process group so closing the terminal does not stop it (only explicit kill/reboot does).
- If killed mid-poll: nothing is written, and the next sweep captures the session. If killed holding `capture-locks/<id>`: the lock is stale and gets stolen on the next acquire — no deadlock.

`captureWithPoll` takes `{ intervalMs, timeoutMs, sleepFn }` so tests can drive the loop without real delays; `TUP_POLL_INTERVAL_MS`/`TUP_POLL_TIMEOUT_MS` env vars bound the detached child's poll for the one test that spawns a real process. Unset in production.

## Alternatives considered
- Block `sessionEnd` until shutdown appears: defeats the purpose of detaching (delays Copilot teardown).
- Reconstruct totals from `assistant.message.outputTokens`: loses the input/cache/reasoning/nano-AIU breakdown that only `session.shutdown` carries.
