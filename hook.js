#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const SESSION_STATE_DIR = path.join(os.homedir(), '.copilot', 'session-state');
const PLUGIN_DIR = path.join(os.homedir(), '.copilot', 'tokendashboard-plugin');
const QUEUE_DIR = path.join(PLUGIN_DIR, 'queue');
const CAPTURED_DIR = path.join(PLUGIN_DIR, 'captured');
const SKIPPED_DIR = path.join(PLUGIN_DIR, 'skipped');
const DEAD_LETTER_DIR = path.join(PLUGIN_DIR, 'dead-letter');
const CAPTURE_LOCK_DIR = path.join(PLUGIN_DIR, 'capture-locks');
const LOCK_FILE = path.join(QUEUE_DIR, '.lock');
const USER_ID_PATH = path.join(PLUGIN_DIR, 'user-id');
const CONFIG_PATH = path.join(PLUGIN_DIR, 'config.json');
const LOG_PATH = path.join(PLUGIN_DIR, 'error.log');
// Reserved for conditions that should never happen (see logException) — distinct from
// error.log's transient/retryable errors, which statusline.js intentionally hides once
// the queue drains (a resolved VPN outage must not show as a permanent red dot).
const EXCEPTIONS_PATH = path.join(PLUGIN_DIR, 'exceptions.txt');
const TIMEOUT_MS = 5000;
// Cap entries per POST so a long offline backlog (many sessions × models) never
// produces one oversized request body that the server might reject wholesale.
const FLUSH_BATCH_SIZE = 500;
// Reading only the tail avoids re-reading large transcripts every sweep; a full-read
// fallback (findShutdownEvent) covers the rare case a shutdown line exceeds this window.
const TAIL_BYTES = 256 * 1024;
const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
// session.shutdown is written after sessionEnd fires, so the detached poller waits for
// it rather than reading once; the sweep remains the backstop for a shutdown never written.
const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 30000;

let writeCounter = 0;

// --- Logging ---

function logError(context, err) {
  try {
    ensurePluginDir();
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} [${context}] ${err}\n`);
  } catch {}
}

// For conditions that should never happen — statusline.js shows a permanent red dot
// while this file is non-empty (no time window, no queue-state coupling), until a
// human reads it, fixes the cause, and clears the file. Use sparingly: only at
// call sites guarding against something the code's own invariants promise can't occur.
function logException(context, err) {
  try {
    ensurePluginDir();
    fs.appendFileSync(EXCEPTIONS_PATH, `${new Date().toISOString()} [${context}] ${err}\n`);
  } catch {}
}

// --- Atomic write ---

function atomicWriteSync(filePath, content) {
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  fs.chmodSync(filePath, 0o600);
}

// --- Dirs ---

function ensurePluginDir() {
  fs.mkdirSync(PLUGIN_DIR, { recursive: true });
}

function ensureQueueDir() {
  fs.mkdirSync(QUEUE_DIR, { recursive: true });
}

// --- User ID ---

function getUserId() {
  if (fs.existsSync(USER_ID_PATH)) {
    return fs.readFileSync(USER_ID_PATH, 'utf8').trim();
  }
  ensurePluginDir();
  const id = crypto.randomUUID();
  atomicWriteSync(USER_ID_PATH, id);
  return id;
}

// --- Config ---

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveConfig(config) {
  ensurePluginDir();
  atomicWriteSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// --- Queue ---

function writeEntry(entry) {
  ensureQueueDir();
  // Counter avoids same-millisecond collisions when one session.shutdown writes several
  // entries (one per model). Atomic tmp+rename, not a plain writeFileSync: a concurrent
  // flush snapshots the queue dir and deletes files on success, so a half-written entry
  // must never be visible in that listing (it would be read as corrupt and lost).
  atomicWriteSync(
    path.join(QUEUE_DIR, `${Date.now()}-${process.pid}-${writeCounter++}.json`),
    JSON.stringify(entry),
  );
}

function getQueueFiles() {
  if (!fs.existsSync(QUEUE_DIR)) {
    return [];
  }
  return fs.readdirSync(QUEUE_DIR)
    .filter(f => f.endsWith('.json') && !f.startsWith('.'))
    .map(f => path.join(QUEUE_DIR, f));
}

// --- Lock ---

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock(lockFile = LOCK_FILE) {
  // Two attempts: first the normal wx, then once more after taking over a stale lock.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // wx is atomic create-if-absent — the canonical acquire.
      fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
      return true;
    } catch {
      let pid;
      try {
        pid = parseInt(fs.readFileSync(lockFile, 'utf8'), 10);
      } catch {
        continue; // Lock vanished between wx-fail and read — retry
      }
      // A live holder with a valid PID owns the lock — back off.
      if (pid && isProcessAlive(pid)) {
        return false;
      }
      // Stale: dead PID, or an empty/NaN file (writer killed between wx and writing its
      // PID). Must be stealable or the lock wedges permanently.
      //
      // Takeover must be atomic: a plain rmSync lets two stealers both remove+recreate and
      // both believe they hold the lock. rename is atomic — exactly one stealer wins it,
      // the rest get ENOENT and retry the wx.
      const aside = `${lockFile}.steal.${process.pid}`;
      try {
        fs.renameSync(lockFile, aside);
      } catch {
        continue; // another stealer moved/replaced it first — retry the wx
      }
      // The renamed-aside file may belong to a faster stealer, not the stale lock we
      // observed — verify, and if it's a live holder, restore it via link (create-only)
      // rather than clobbering a newer lock.
      let stolenPid;
      try {
        stolenPid = parseInt(fs.readFileSync(aside, 'utf8'), 10);
      } catch {
        stolenPid = NaN;
      }
      if (stolenPid && stolenPid !== pid && isProcessAlive(stolenPid)) {
        try {
          fs.linkSync(aside, lockFile);
        } catch {}
        try {
          fs.rmSync(aside);
        } catch {}
        return false;
      }
      // Confirmed stale — discard it and retry the wx.
      try {
        fs.rmSync(aside);
      } catch {}
    }
  }
  return false;
}

function releaseLock(lockFile = LOCK_FILE) {
  try {
    fs.rmSync(lockFile);
  } catch {}
}

// --- HTTP ---

// Timer stays armed through the body read (via readBody), not just headers — a captive
// portal can stall the body after sending headers, and this must still time out. Returns
// { res, body } on success, or null on any error/timeout/abort.
async function fetchWithTimeout(url, options = {}, timeoutMs = TIMEOUT_MS, readBody = null) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!readBody) {
      return res;
    }
    const body = await readBody(res);
    return { res, body };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// --- Session JSONL parsing ---

// Read the last `maxBytes` of a file. Returns { text, truncated } where truncated
// is true when the file is larger than the window (so the first line may be partial).
function readTail(eventsPath, maxBytes) {
  const fd = fs.openSync(eventsPath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buf = Buffer.alloc(length);
    if (length > 0) {
      fs.readSync(fd, buf, 0, length, start);
    }
    return { text: buf.toString('utf8'), truncated: start > 0 };
  } finally {
    fs.closeSync(fd);
  }
}

function scanForShutdown(lines) {
  // session.shutdown is the final event — scan from the end.
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]);
      if (obj.type === 'session.shutdown') {
        return obj;
      }
    } catch {}
  }
  return null;
}

function findShutdownEvent(eventsPath) {
  // Fast path: read only the tail. session.shutdown, if present, is the last line.
  const { text, truncated } = readTail(eventsPath, TAIL_BYTES);
  const lines = text.split('\n').filter(Boolean);

  const found = scanForShutdown(lines);
  if (found) {
    return found;
  }

  // No shutdown in the tail. Full re-read only if the last line is unparseable AND the
  // tail was truncated — the shutdown line itself may exceed the window. A parsing last
  // line means the file genuinely ends without one (cheap, common miss).
  let lastLineComplete = false;
  if (lines.length > 0) {
    try {
      JSON.parse(lines[lines.length - 1]);
      lastLineComplete = true;
    } catch {}
  }
  if (truncated && !lastLineComplete) {
    const allLines = fs.readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean);
    return scanForShutdown(allLines);
  }
  return null;
}

// --- Captured-session markers ---
//
// captured/<id> is a presence marker — a session's single session.shutdown is either
// queued or not. The file's content is unused; existence is the signal.
function isCaptured(sessionId) {
  return fs.existsSync(path.join(CAPTURED_DIR, sessionId));
}

function markCaptured(sessionId) {
  fs.mkdirSync(CAPTURED_DIR, { recursive: true });
  atomicWriteSync(path.join(CAPTURED_DIR, sessionId), '');
}

// --- Processed checkpoints ---
//
// Records each swept session's events.jsonl (mtime,size) so an unchanged file is skipped
// next sweep — covers both shutdown-less (crashed) and already-captured sessions. Stat-based,
// never time-based, so a shutdown appended after an earlier read is never permanently missed.

function readSkipCheckpoint(sessionId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(SKIPPED_DIR, sessionId), 'utf8'));
  } catch {
    return null;
  }
}

function writeSkipCheckpoint(sessionId, stat) {
  fs.mkdirSync(SKIPPED_DIR, { recursive: true });
  atomicWriteSync(
    path.join(SKIPPED_DIR, sessionId),
    JSON.stringify({ mtimeMs: stat.mtimeMs, size: stat.size }),
  );
}

// Removes markers whose session-state dir no longer exists, so marker dirs don't grow
// unbounded. Capture locks share the same orphan test; a live lock's dir still exists.
function pruneOrphanMarkers(existingDirs) {
  for (const markerDir of [CAPTURED_DIR, SKIPPED_DIR, CAPTURE_LOCK_DIR]) {
    let markers = [];
    try {
      markers = fs.readdirSync(markerDir);
    } catch {
      continue; // dir doesn't exist yet
    }
    for (const name of markers) {
      if (!existingDirs.has(name)) {
        try {
          fs.rmSync(path.join(markerDir, name));
        } catch {}
      }
    }
  }
}

// --- Usage extraction ---

// Build a per-model usage entry from a single modelMetrics record. usage.inputTokens is
// cumulative (incl. cache reads); tokenDetails.input.tokenCount is non-cached input — kept
// split so input/cache_read aren't double-counted.
function entryFromModelMetrics(model, m, sessionId, timestamp) {
  const td = m.tokenDetails ?? {};
  return {
    timestamp,
    session_id: sessionId,
    model,
    usage: {
      input_tokens:       td.input?.tokenCount ?? 0,
      output_tokens:      td.output?.tokenCount ?? 0,
      cache_read_tokens:  td.cache_read?.tokenCount ?? 0,
      cache_write_tokens: m.usage?.cacheWriteTokens ?? 0,
      reasoning_tokens:   m.usage?.reasoningTokens ?? 0,
    },
    requests:               m.requests?.count ?? 0,
    total_nano_aiu:         m.totalNanoAiu ?? 0,
    total_premium_requests: m.requests?.cost ?? 0,
  };
}

// --- Capture one session ---

// Write one queue entry per model for a session's session.shutdown event, falling back to
// the session-level totals when the per-model breakdown is absent.
function writeShutdownEntries(sessionId, event) {
  // Default data to {} so a shutdown missing its data field still yields a (zeroed)
  // fallback entry instead of throwing.
  const data = event.data ?? {};
  const ts = event.timestamp ?? new Date().toISOString();
  const metrics = data.modelMetrics ?? {};
  const models = Object.keys(metrics);

  // One entry per model — keeps the per-model breakdown that's lost when a session
  // switches models mid-run (session.model_change).
  if (models.length > 0) {
    for (const model of models) {
      writeEntry(entryFromModelMetrics(model, metrics[model], sessionId, ts));
    }
  } else {
    // No per-model breakdown available — fall back to the session-level totals.
    writeEntry({
      timestamp: ts,
      session_id: sessionId,
      model: data.currentModel ?? 'unknown',
      usage: {
        input_tokens:       data.tokenDetails?.input?.tokenCount ?? 0,
        output_tokens:      data.tokenDetails?.output?.tokenCount ?? 0,
        cache_read_tokens:  data.tokenDetails?.cache_read?.tokenCount ?? 0,
        // Session-level tokenDetails carries cache_write for some models; read it the same
        // way as the others. No session-level reasoning aggregate exists, so it stays 0.
        cache_write_tokens: data.tokenDetails?.cache_write?.tokenCount ?? 0,
        reasoning_tokens:   0,
      },
      requests:               0,
      total_nano_aiu:         data.totalNanoAiu ?? 0,
      total_premium_requests: data.totalPremiumRequests ?? 0,
    });
  }
}

// Captures a session's shutdown if present and not yet queued. Returns 1 if newly
// captured, 0 if no shutdown yet or already captured (sweep may checkpoint), -1 = lock
// held by another live process (sweep must NOT checkpoint — that process could die first).
function captureSession(sessionId) {
  if (!sessionId || sessionId.includes('/') || sessionId.includes('\\') || sessionId === '..') {
    logException('captureSession', new Error(`unsafe sessionId: ${JSON.stringify(sessionId)}`));
    return 0;
  }
  if (isCaptured(sessionId)) {
    return 0;
  }
  const eventsPath = path.join(SESSION_STATE_DIR, sessionId, 'events.jsonl');
  if (!fs.existsSync(eventsPath)) {
    return 0;
  }

  let event;
  try {
    event = findShutdownEvent(eventsPath);
  } catch (err) {
    logError('captureSession', err);
    return 0;
  }
  if (!event) {
    return 0; // session still running or no shutdown written yet
  }

  // Per-session lock makes the check-then-write-then-mark sequence one atomic critical
  // section — otherwise two concurrent processes (poller + sweep) could both pass the
  // isCaptured check and both write entries before either marks the session captured. A
  // holder that crashes mid-capture leaves a stale lock (stolen next attempt) and no
  // marker, so the session is recovered on a later sweep rather than lost.
  fs.mkdirSync(CAPTURE_LOCK_DIR, { recursive: true });
  const lockFile = path.join(CAPTURE_LOCK_DIR, sessionId);
  if (!acquireLock(lockFile)) {
    return -1; // another live process is capturing this session
  }

  try {
    // Re-check under the lock: the holder we raced may have captured it between our
    // isCaptured check above and acquireLock.
    if (isCaptured(sessionId)) {
      return 0;
    }
    writeShutdownEntries(sessionId, event);
    markCaptured(sessionId);
    return 1;
  } finally {
    releaseLock(lockFile);
  }
}

// Capture every uncaptured session except the one currently running. Used by the
// background sweep on session start to pick up sessions that sessionEnd missed
// (Ctrl+C, crash, or the shutdown event being written after the hook fired).
function sweep(currentSessionId) {
  if (!fs.existsSync(SESSION_STATE_DIR)) {
    return;
  }
  let dirs = [];
  try {
    dirs = fs.readdirSync(SESSION_STATE_DIR);
  } catch {
    return;
  }

  pruneOrphanMarkers(new Set(dirs));

  for (const dir of dirs) {
    if (dir === currentSessionId) {
      continue;
    }

    let stat;
    try {
      stat = fs.statSync(path.join(SESSION_STATE_DIR, dir, 'events.jsonl'));
    } catch {
      continue; // no events.jsonl yet
    }

    // Skip if unchanged since we last processed it — captured or not. A late-appended
    // session.shutdown changes (mtime,size), forcing a re-read that captures it.
    const cp = readSkipCheckpoint(dir);
    if (cp && cp.mtimeMs === stat.mtimeMs && cp.size === stat.size) {
      continue;
    }

    let result;
    try {
      result = captureSession(dir);
    } catch (err) {
      logError('sweep', err);
      continue;
    }
    // Record the processed stat so the next sweep skips this file until it changes again.
    // Withhold the checkpoint only on lock contention (result === -1): another live process
    // is capturing it, and if that process dies we must re-read on a later sweep.
    if (result !== -1) {
      writeSkipCheckpoint(dir, stat);
    }
  }
}

// Strip a trailing slash from `base` so a configured `repoRawBaseUrl` ending in `/`
// (e.g. a fork's raw-file base pasted with a trailing slash) doesn't produce a
// double-slash path like `.../main//package.json`.
const rawUrl = (base, file) => `${base.replace(/\/$/, '')}/${file}`;

// The ingest route lives at a fixed path under whatever base URL is configured
// (`--api-base-url` at install time) — installers only need to know their own
// deployment's origin, not the full route.
const INGEST_PATH = '/api/usage/ingest/copilot';
const ingestUrl = apiBaseUrl => `${apiBaseUrl.replace(/\/$/, '')}${INGEST_PATH}`;

// --- Flush (background / session end) ---

// A 2xx alone doesn't prove delivery: off-VPN, a captive portal/proxy can answer 200 HTML
// or a followed redirect. Deleting entries on that response would lose data silently, so
// only a non-redirected 2xx with a non-HTML body counts as success.
function isIngestSuccess(res) {
  if (!res || !res.ok || res.redirected) {
    return false;
  }
  const contentType = res.headers?.get?.('content-type') ?? '';
  return !contentType.includes('text/html');
}

// Only 400/422 (server understood and permanently rejects the body) is non-retryable.
// Everything else — no response, 5xx, 408/429, a proxy 401/403/407 (the flush sends no
// credentials, so the ingest endpoint itself never issues these), a transient 404/405, or
// a non-genuine 2xx — stays queued. Defaulting to retryable means a transient blip never
// dead-letters real data; the trade-off is a wrong ENDPOINT just grows the queue instead.
function isRetryable(res) {
  if (!res) {
    return true;
  }
  if (res.ok || res.redirected) {
    return true; // 2xx-but-not-genuine (captive portal) or a followed redirect
  }
  return ![400, 422].includes(res.status);
}

// Move a rejected batch out of the live queue into dead-letter/ so it stops being
// retried (and stops blocking the batches behind it) while preserving the data for
// later inspection. Rename keeps it atomic; a failed move falls back to a delete so a
// poison entry can never wedge the queue.
function deadLetter(batch) {
  fs.mkdirSync(DEAD_LETTER_DIR, { recursive: true });
  for (const f of batch) {
    try {
      fs.renameSync(f, path.join(DEAD_LETTER_DIR, path.basename(f)));
    } catch {
      try {
        fs.rmSync(f);
      } catch {}
    }
  }
}

// Delivers one batch. Success removes its files; a transient failure leaves them queued
// and returns false (stop the flush). A permanent rejection bisects the batch so a single
// poison entry doesn't drag its neighbours into dead-letter.
async function deliverBatch(batch, userId, pluginVersion, url) {
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId, plugin_version: pluginVersion, prompts: batch.map(b => b.entry) }),
  });

  if (isIngestSuccess(res)) {
    batch.forEach(b => {
      try {
        fs.rmSync(b.file);
      } catch {}
    });
    return true;
  }

  if (isRetryable(res)) {
    // Transient — leave this batch queued and tell the caller to stop.
    logError('flush', `${res ? `HTTP ${res.status}` : 'network error'} — ${batch.length} entries remain in queue`);
    return false;
  }

  // Permanent client error (400/422). A multi-entry batch may be poisoned by a single
  // bad entry, so bisect to isolate it rather than quarantining the whole batch. A lone
  // entry the server still rejects is the genuine offender → dead-letter it.
  if (batch.length === 1) {
    deadLetter(batch.map(b => b.file));
    logError('flush', `HTTP ${res.status} — quarantined 1 entry to dead-letter`);
    return true;
  }
  const mid = Math.floor(batch.length / 2);
  // A transient failure in the first half (false) stops the flush before the second is
  // even attempted, so its files stay queued for the next run — no data lost.
  return (await deliverBatch(batch.slice(0, mid), userId, pluginVersion, url))
    && deliverBatch(batch.slice(mid), userId, pluginVersion, url);
}

async function flush() {
  const files = getQueueFiles();
  if (files.length === 0) {
    return;
  }
  // No hardcoded default — apiBaseUrl comes only from install-time config (ADR-011). Its
  // absence means a pre-ADR-011 install or corrupt config; fail closed, keep the queue.
  const apiBaseUrl = loadConfig().apiBaseUrl;
  if (!apiBaseUrl) {
    logError('flush', 'no api base url configured in config.json — reinstall with --api-base-url <url>');
    return;
  }
  if (!acquireLock()) {
    return;
  }

  try {
    // Pair each file with its parsed entry. A file that won't parse is local
    // corruption (writeEntry is atomic, so it is never a half-written file) — drop it
    // outright; it can never become a valid request.
    const items = [];
    for (const f of files) {
      let entry;
      try {
        entry = JSON.parse(fs.readFileSync(f, 'utf8'));
      } catch {
        try {
          fs.rmSync(f);
        } catch {}
        continue;
      }
      items.push({ file: f, entry });
    }
    if (items.length === 0) {
      return;
    }

    const userId = getUserId();
    // Version of the running plugin, tracked in config (set at install, advanced by the
    // auto-updater in lockstep with hook.js). 'unknown' if config is missing/pre-versioned.
    const pluginVersion = loadConfig().currentVersion ?? 'unknown';
    const url = ingestUrl(apiBaseUrl);
    for (let i = 0; i < items.length; i += FLUSH_BATCH_SIZE) {
      const batch = items.slice(i, i + FLUSH_BATCH_SIZE);
      if (!(await deliverBatch(batch, userId, pluginVersion, url))) {
        return; // transient failure — leave this batch and everything after it queued
      }
    }
  } finally {
    releaseLock();
  }
}

// --- Background spawn ---

function spawnBackground(...args) {
  const child = spawn(process.execPath, [__filename, ...args], { detached: true, stdio: 'ignore' });
  child.unref();
}

// --- Poll-and-capture (detached, runs after the session has ended) ---

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Copilot writes session.shutdown a moment AFTER sessionEnd returns, so polling (rather
// than a single read) is required to catch the just-ended session without waiting for the
// next session's sweep. Runs detached so Copilot's exit is never blocked.
//
// sleepFn/interval/timeout are test seams; TUP_POLL_*_MS env vars bound the one test that
// spawns a real detached child.
async function captureWithPoll(sessionId, {
  intervalMs = Number(process.env.TUP_POLL_INTERVAL_MS) || POLL_INTERVAL_MS,
  timeoutMs = Number(process.env.TUP_POLL_TIMEOUT_MS) || POLL_TIMEOUT_MS,
  sleepFn = sleep,
} = {}) {
  if (sessionId && !isCaptured(sessionId)) {
    const attempts = Math.max(1, Math.floor(timeoutMs / intervalMs));
    for (let i = 0; i < attempts; i++) {
      let result = 0;
      try {
        result = captureSession(sessionId);
      } catch (err) {
        logError('capture-poll', err);
      }
      // Captured (1), or another live process is handling it (-1) — either way, done polling.
      if (result !== 0) {
        break;
      }
      // Shutdown not written yet — wait and retry (no sleep after the final attempt).
      if (i < attempts - 1) {
        await sleepFn(intervalMs);
      }
    }
  }
  await flush();
}

// --- sessionEnd hook ---

// Capture runs in a detached poller, not inline: session.shutdown is written only after
// this hook returns, so an inline read would miss it (see captureWithPoll).
function onSessionEnd(hookData, spawnFn = spawnBackground) {
  spawnFn('--capture', hookData.sessionId ?? '');
}

// --- sessionStart hook (synchronous, exits fast) ---

// spawnFn is a seam for tests; production calls it with the real spawnBackground.
function onSessionStart(hookData, spawnFn = spawnBackground) {
  const { sessionId: currentSessionId } = hookData;

  // Sweep previous sessions + flush in the background so session start stays fast,
  // regardless of how many old session-state dirs exist.
  spawnFn('--sweep', currentSessionId ?? '');

  // Update check throttled to once per 24h
  const config = loadConfig();
  if (!config.currentVersion) {
    return;
  }
  const lastCheck = config.lastUpdateCheck ? new Date(config.lastUpdateCheck) : null;
  if (lastCheck && (Date.now() - lastCheck.getTime()) < UPDATE_INTERVAL_MS) {
    return;
  }
  // Timestamp is written by converge (inside the fetched updater.js) after a successful
  // server contact, so a failed check (e.g. VPN off) is retried next session instead of
  // waiting 24h.
  spawnFn('--update');
}

// --- Loader (fetch updater.js fresh and run it via stdin) ---
//
// hook.js contains no update logic — updater.js is fetched fresh on every check and run
// via `node -` (never written to disk), so a bug fix there ships on the next check, not
// the next manual reinstall. This loader is the only permanently-frozen update code
// (see ADR-012).

// runFn is a seam for tests; production uses runUpdaterSource.
async function updateFromRemote(runFn = runUpdaterSource) {
  const config = loadConfig();
  if (!config.currentVersion) {
    return;
  }

  // repoRawBaseUrl comes only from install-time config (ADR-011), no hardcoded default.
  // Missing means "not installed" — never fetch.
  const rawBase = config.repoRawBaseUrl;
  if (!rawBase) {
    return;
  }

  const updater = await fetchWithTimeout(
    rawUrl(rawBase, 'updater.js'), {}, 10000, r => r.text());
  if (!updater?.res?.ok || updater.res.redirected) {
    return;
  }

  const source = updater.body;
  if (source.trimStart().startsWith('<!')) {
    return; // HTML error/captive-portal page, not source
  }

  runFn(source);
}

// Piped via stdin (`node -`) rather than written to disk — works under noexec mounts,
// needs no external tools. updater.js derives its own paths from os.homedir().
function runUpdaterSource(source) {
  const child = spawn(process.execPath, ['-'], {
    env: { ...process.env, TUP_MODE: 'converge' },
    stdio: ['pipe', 'ignore', 'ignore'],
    detached: true,
  });
  child.on('error', () => {}); // e.g. spawn failure — nothing to do in a background hook
  child.stdin.on('error', () => {}); // swallow EPIPE if the child exits early
  child.stdin.write(source);
  child.stdin.end();
  child.unref();
}

// --- Main ---

async function main() {
  const mode = process.argv[2];

  if (mode === '--flush') {
    await flush();
    return;
  }
  if (mode === '--sweep') {
    sweep(process.argv[3] || null);
    await flush();
    return;
  }
  if (mode === '--capture') {
    await captureWithPoll(process.argv[3] || null);
    return;
  }
  if (mode === '--update') {
    await updateFromRemote();
    return;
  }

  // Remaining modes require hook data from stdin
  let payload = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    payload += chunk;
  }
  let hookData = {};
  try {
    hookData = JSON.parse(payload);
  } catch {}

  if (mode === '--session-start') {
    onSessionStart(hookData);
    return;
  }
  if (mode === '--session-end') {
    onSessionEnd(hookData);
    return;
  }
}

if (require.main === module) {
  main().catch(err => {
    logError('main', err);
    process.exit(0);
  });
}

module.exports = {
  atomicWriteSync,
  getUserId,
  loadConfig,
  saveConfig,
  writeEntry,
  getQueueFiles,
  acquireLock,
  releaseLock,
  isProcessAlive,
  readTail,
  findShutdownEvent,
  isCaptured,
  markCaptured,
  readSkipCheckpoint,
  writeSkipCheckpoint,
  pruneOrphanMarkers,
  entryFromModelMetrics,
  writeShutdownEntries,
  captureSession,
  sweep,
  isRetryable,
  isIngestSuccess,
  deadLetter,
  flush,
  FLUSH_BATCH_SIZE,
  captureWithPoll,
  onSessionStart,
  onSessionEnd,
  rawUrl,
  updateFromRemote,
  runUpdaterSource,
  logException,
};
