# ADR-004: Queue Directory over Single Queue File (Concurrency Safety)

## Decision
Entries are queued as one file per entry, not one shared JSON file:

```
~/.copilot/tokendashboard-plugin/queue/
  1749123456789-42-0.json    ← [timestamp]-[pid]-[counter].json
  .lock                       ← flush lock
```

## Why
- Multiple hook processes (a `sessionEnd` capture, a `sessionStart` sweep, a `--flush`) can run concurrently. A single queue file needs read-modify-write, which is not atomic — concurrent writers overwrite each other's entries. Per-file writes are atomic OS-level file creation, so no two processes collide.
- The filename's `writeCounter` is needed because one `captureSession` call can write multiple entries (one per model) within the same millisecond; `timestamp+pid` alone would collide.
- The flush lock (`O_CREAT|O_EXCL`, i.e. `wx`) lets only one flush run at a time; a stale lock (owning process dead) is stolen on the next acquire.
- A flush snapshots the directory listing at startup and only processes those files, so entries written mid-flush are left for the next run rather than raced.
- The queue directory must not be deleted while entries are pending — they would be lost.
