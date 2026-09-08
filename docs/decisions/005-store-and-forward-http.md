# ADR-005: Store-and-Forward to HTTP Endpoint over Local JSON File

## Decision
Captured entries are written locally to a queue and sent as a batch via HTTP POST to the configured ingest endpoint (`apiBaseUrl` + fixed ingest path, see ADR-011). If unreachable, entries stay queued and are retried on the next flush. Requests use a 5s timeout (`TIMEOUT_MS`) and send no credentials.

A flush sends the queue in batches of `FLUSH_BATCH_SIZE` (500), not as one request, so a long offline backlog can't build one oversized body.

Each batch's outcome is classified:
- **Genuine 2xx** (`isIngestSuccess`) → batch's files deleted.
- **Retryable** (no response/timeout, 5xx, 408, 429, proxy/auth 401/403/407, a transient 404/405, or a 2xx that isn't a genuine ingest) → flush stops; this batch and everything after stays queued. This is the default outcome for anything that isn't a clear content rejection.
- **Permanent (400/422)** → the batch is bisected (`deliverBatch`) and each half retried, narrowing down to the offending entry; only an entry the server still rejects alone is moved to `dead-letter/` (never auto-pruned).

## Why
- Central, company-wide analysis requires a server; a local-file-only design leaves data scattered across devices.
- Employees are not always on VPN — an inline synchronous POST in the hook would block session start/end on a 5s timeout. The queue decouples capture from delivery; flush always runs as a detached background process.
- A 2xx status alone isn't proof of delivery: off-VPN, a captive portal or auth proxy commonly answers with its own 200 HTML login page, or a 3xx redirect `fetch` follows transparently. Treating either as success would delete queued entries without ever reaching the real endpoint. `isIngestSuccess` requires a non-redirected 2xx with a non-HTML body.
- Retrying a permanent rejection would never succeed and would block every entry behind it forever; bisecting isolates the one poison entry instead of dead-lettering its whole batch.
- A queue file that fails to parse is treated as local corruption (writes are atomic tmp+rename, so it can't be a half-write) and is deleted rather than retried.
- Entries are only lost if the capturing process is killed before the atomic queue write completes.
- A genuinely wrong endpoint is never dead-lettered (only 400/422 is) — the queue grows until the config is fixed, rather than silently discarding real data.
