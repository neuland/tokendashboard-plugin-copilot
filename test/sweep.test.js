'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { inSandbox, writeSession, capturedDir, skippedDir, pluginDir } = require('./helpers.js');

const captureLockDir = home => path.join(pluginDir(home), 'capture-locks');

function singleModelShutdown() {
  return {
    currentModel: 'gpt-5.4-mini',
    modelMetrics: {
      'gpt-5.4-mini': {
        requests: { count: 1, cost: 0 },
        usage: { cacheWriteTokens: 0, reasoningTokens: 0 },
        totalNanoAiu: 1,
        tokenDetails: { input: { tokenCount: 1 }, output: { tokenCount: 1 }, cache_read: { tokenCount: 1 } },
      },
    },
  };
}

// --- Reading shutdowns from large events.jsonl ---

test('captureSession captures a shutdown in a very large events.jsonl', () => {
  inSandbox((hook, home) => {
    // given — events.jsonl far larger than the old 256 KB tail window, shutdown as last line
    const filler = Array.from({ length: 4000 }, (_, i) => ({ type: 'assistant.message', data: 'x'.repeat(100), i }));
    writeSession(home, 'big', { events: filler, shutdownData: singleModelShutdown() });
    assert.ok(fs.statSync(path.join(home, '.copilot', 'session-state', 'big', 'events.jsonl')).size > 256 * 1024);

    // when
    const captured = hook.captureSession('big');

    // then — the full read found the shutdown (one shutdown newly captured)
    assert.equal(captured, 1);
    assert.equal(hook.getQueueFiles().length, 1);
  });
});

test('captureSession captures a shutdown whose own JSON line is very large', () => {
  inSandbox((hook, home) => {
    // given — a shutdown whose own JSON line is larger than the old tail window
    const sd = singleModelShutdown();
    sd.codeChanges = { filesModified: Array.from({ length: 20000 }, (_, i) => `/some/very/long/path/file-${i}.ts`) };
    const filler = Array.from({ length: 3000 }, () => ({ type: 'assistant.message', data: 'y'.repeat(100) }));
    writeSession(home, 'hugeshutdown', { events: filler, shutdownData: sd });

    // when
    const captured = hook.captureSession('hugeshutdown');

    // then — the full-read fallback in findShutdownEvent finds it
    assert.equal(captured, 1);
    assert.equal(hook.getQueueFiles().length, 1);
  });
});

test('findShutdownEvent does not full-read a large shutdown-less session', () => {
  inSandbox((hook, home) => {
    // given — a large session that ends on a complete non-shutdown event
    const filler = Array.from({ length: 4000 }, (_, i) => ({ type: 'assistant.message', data: 'z'.repeat(100), i }));
    writeSession(home, 'running-big', { events: filler });
    const eventsPath = path.join(home, '.copilot', 'session-state', 'running-big', 'events.jsonl');

    // when
    const event = hook.findShutdownEvent(eventsPath);

    // then — no shutdown reported
    assert.equal(event, null);
  });
});

// --- Orphan-marker pruning (Maßnahme 2) ---

test('sweep prunes captured/skip markers whose session dir no longer exists', () => {
  inSandbox((hook, home) => {
    // given — markers for sessions that do not exist, plus one live session
    hook.markCaptured('ghost-captured');
    fs.mkdirSync(skippedDir(home), { recursive: true });
    fs.writeFileSync(path.join(skippedDir(home), 'ghost-skipped'), '{}');
    writeSession(home, 'live', { shutdownData: singleModelShutdown() });

    // when
    hook.sweep('current');

    // then — orphan markers gone, live session captured
    assert.equal(fs.existsSync(path.join(capturedDir(home), 'ghost-captured')), false);
    assert.equal(fs.existsSync(path.join(skippedDir(home), 'ghost-skipped')), false);
    assert.equal(hook.isCaptured('live'), true);
  });
});

// --- Skip checkpoints (Maßnahme 3) ---

test('sweep records a skip checkpoint for a shutdown-less session', () => {
  inSandbox((hook, home) => {
    // given — a session that never wrote a shutdown
    writeSession(home, 'crashed', { events: [{ type: 'session.start' }] });

    // when
    hook.sweep('current');

    // then — not captured, but a checkpoint with the file's stat was recorded
    assert.equal(hook.isCaptured('crashed'), false);
    const cp = JSON.parse(fs.readFileSync(path.join(skippedDir(home), 'crashed'), 'utf8'));
    const stat = fs.statSync(path.join(home, '.copilot', 'session-state', 'crashed', 'events.jsonl'));
    assert.equal(cp.size, stat.size);
    assert.equal(cp.mtimeMs, stat.mtimeMs);
  });
});

test('a shutdown written after the checkpoint is picked up on the next sweep', () => {
  inSandbox((hook, home) => {
    // given — a shutdown-less session checkpointed by a first sweep
    writeSession(home, 's', { events: [{ type: 'session.start' }] });
    hook.sweep('current');
    assert.equal(hook.isCaptured('s'), false);
    assert.equal(fs.existsSync(path.join(skippedDir(home), 's')), true);

    // when — the session later writes its shutdown (file changes), then a sweep runs
    writeSession(home, 's', { events: [{ type: 'session.start' }], shutdownData: singleModelShutdown() });
    hook.sweep('current');

    // then — the changed file was re-read and captured; the checkpoint is refreshed to the
    // new stat (kept, not cleared) so a further sweep skips until the next prompt grows it
    assert.equal(hook.isCaptured('s'), true);
    assert.equal(hook.getQueueFiles().length, 1);
    const cp = JSON.parse(fs.readFileSync(path.join(skippedDir(home), 's'), 'utf8'));
    const stat = fs.statSync(path.join(home, '.copilot', 'session-state', 's', 'events.jsonl'));
    assert.equal(cp.size, stat.size);
    assert.equal(cp.mtimeMs, stat.mtimeMs);
  });
});

// --- Per-session capture lock (concurrent-capture dedup) ---

test('captureSession writes nothing while another live process holds the session lock', () => {
  inSandbox((hook, home) => {
    // given — a capturable session whose per-session lock is held by a live process
    // (this test process), standing in for a concurrent sessionEnd/sweep capture
    writeSession(home, 'contended', { shutdownData: singleModelShutdown() });
    fs.mkdirSync(captureLockDir(home), { recursive: true });
    assert.equal(hook.acquireLock(path.join(captureLockDir(home), 'contended')), true);

    // when — a second capture races for the same session
    const captured = hook.captureSession('contended');

    // then — reported as contended (-1), but no entry written and no marker set (the lock
    // holder owns those), so the session's tokens are not double-counted
    assert.equal(captured, -1);
    assert.equal(hook.getQueueFiles().length, 0);
    assert.equal(hook.isCaptured('contended'), false);
  });
});

test('captureSession is idempotent — a second capture of the same session writes once', () => {
  inSandbox((hook, home) => {
    // given — a session already captured once
    writeSession(home, 'once', { shutdownData: singleModelShutdown() });
    assert.equal(hook.captureSession('once'), 1);
    assert.equal(hook.getQueueFiles().length, 1);

    // when — captured again (already caught up)
    const second = hook.captureSession('once');

    // then — nothing new, no duplicate entry
    assert.equal(second, 0);
    assert.equal(hook.getQueueFiles().length, 1);
  });
});

test('captureSession steals a stale session lock left by a dead process', () => {
  inSandbox((hook, home) => {
    // given — a capturable session whose lock file names a dead pid
    writeSession(home, 'stale', { shutdownData: singleModelShutdown() });
    fs.mkdirSync(captureLockDir(home), { recursive: true });
    fs.writeFileSync(path.join(captureLockDir(home), 'stale'), '999999');

    // when
    const captured = hook.captureSession('stale');

    // then — the stale lock was stolen and the session captured exactly once
    assert.equal(captured, 1);
    assert.equal(hook.isCaptured('stale'), true);
    assert.equal(hook.getQueueFiles().length, 1);
  });
});

test('sweep prunes a stale capture lock whose session dir no longer exists', () => {
  inSandbox((hook, home) => {
    // given — an orphan capture lock plus one live session
    fs.mkdirSync(captureLockDir(home), { recursive: true });
    fs.writeFileSync(path.join(captureLockDir(home), 'ghost-lock'), '999999');
    writeSession(home, 'live', { shutdownData: singleModelShutdown() });

    // when
    hook.sweep('current');

    // then — orphan lock gone, live session captured
    assert.equal(fs.existsSync(path.join(captureLockDir(home), 'ghost-lock')), false);
    assert.equal(hook.isCaptured('live'), true);
  });
});
