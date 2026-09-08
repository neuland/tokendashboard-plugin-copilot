# ADR-007: Token Capture from session.shutdown (and why no subagent capture)

## Decision
`captureSession` reads `session.shutdown` events from `~/.copilot/session-state/<id>/events.jsonl` and writes one queue entry per model from `data.modelMetrics`:

| Field | Source |
|---|---|
| `usage.input_tokens` | `modelMetrics[m].tokenDetails.input.tokenCount` |
| `usage.output_tokens` | `modelMetrics[m].tokenDetails.output.tokenCount` |
| `usage.cache_read_tokens` | `modelMetrics[m].tokenDetails.cache_read.tokenCount` |
| `usage.cache_write_tokens` | `modelMetrics[m].usage.cacheWriteTokens` |
| `usage.reasoning_tokens` | `modelMetrics[m].usage.reasoningTokens` |
| `requests` | `modelMetrics[m].requests.count` |
| `total_nano_aiu` | `modelMetrics[m].totalNanoAiu` |
| `total_premium_requests` | `modelMetrics[m].requests.cost` |

If `modelMetrics` is empty/absent, one entry is written from session-level `data.tokenDetails`/`data.totalNanoAiu`/`data.totalPremiumRequests`, keyed on `data.currentModel`.

`session.shutdown` is the last line of `events.jsonl`, which can grow to hundreds of KB. `findShutdownEvent` reads only the last `TAIL_BYTES` (256 KB); a full read is triggered only when that tail's last line fails to parse while the window was truncated (i.e. the shutdown line itself exceeds the window).

Per-session state:
- `captured/<session-id>` — presence marker (empty file) for whether that session's shutdown has been queued. A session produces at most one `session.shutdown`, so presence is enough — no count needed.
- `capture-locks/<session-id>` — lock guarding the check-then-write-then-mark critical section, using the same `acquireLock`/`releaseLock` primitive as the flush queue lock. A stale lock (holder dead) is stolen by the next attempt.
- `skipped/<session-id>` — `(mtimeMs, size)` checkpoint; the sweep skips a session with a single `statSync` while both are unchanged, and re-reads as soon as either changes (a late-appended shutdown is detected — no time-based give-up).

Both marker directories are pruned each sweep (`pruneOrphanMarkers`) for markers whose `session-state` dir no longer exists.

## Why
- `session.shutdown` is the only event carrying the full per-model token breakdown (input/cache/reasoning/nano-AIU); intermediate events don't expose it.
- Reporting `tokenDetails.input` (non-cached) separately from `cache_read_tokens` avoids double-counting, since `usage.inputTokens` is cumulative *including* cache reads.
- The count-then-write-then-advance sequence must be lock-guarded: the marker/count is checked at the start and written at the end, so two processes (a `sessionEnd` poll and a concurrent sweep) can otherwise both pass the check and both write entries before either advances the count — duplicating tokens.
- `session.shutdown.modelMetrics` is aggregated for the whole session including any subagent activity — there's no separate per-subagent transcript to walk, so the Claude plugin's subagent-specific handling has no analog here; usage is attributed at session+model granularity, not per turn or per subagent.
- The `events.jsonl` file and `session.shutdown` schema are not a public/documented contract; if Copilot changes them, capture degrades gracefully (returns without queuing).
