'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { withTempHome, runHookProcess, writeSession, queueDir, capturedDir } = require('./helpers.js');

// main() is exercised end-to-end as a child process so its argv dispatch and stdin
// handling run for real. Only network-safe modes are used: --flush returns before
// any fetch on an empty queue, and --session-end against a still-running session
// captures nothing (so the detached --capture process it spawns is a no-op). That
// detached poller is bounded to a zero timeout via env so it exits at once instead
// of polling for the production 30s.
// (--do-update / --sweep hit real hosts and are covered directly in other suites.)
const NO_POLL = { TUP_POLL_TIMEOUT_MS: '0' };

const readQueue = home =>
  (fs.existsSync(queueDir(home)) ? fs.readdirSync(queueDir(home)) : [])
    .filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(queueDir(home), f), 'utf8')));

test('main with no mode parses stdin and exits cleanly without queuing', () => {
  const { home, cleanup } = withTempHome();
  try {
    // given — a hook payload but no mode argument
    const input = JSON.stringify({ sessionId: 'sess-1' });

    // when
    const res = runHookProcess([], { home, input });

    // then — clean exit, nothing queued (no mode matched)
    assert.equal(res.status, 0);
    assert.equal(readQueue(home).length, 0);
  } finally {
    cleanup();
  }
});

test('main tolerates malformed stdin without crashing', () => {
  const { home, cleanup } = withTempHome();
  try {
    // given — stdin that is not valid JSON

    // when
    const res = runHookProcess(['--session-end'], { home, input: 'not json {' });

    // then — exits cleanly and queues nothing
    assert.equal(res.status, 0);
    assert.equal(readQueue(home).length, 0);
  } finally {
    cleanup();
  }
});

test('main (--flush) exits cleanly and makes no request on an empty queue', () => {
  const { home, cleanup } = withTempHome();
  try {
    // given — no queued entries

    // when
    const res = runHookProcess(['--flush'], { home });

    // then — the flush dispatch route returns before touching the network
    assert.equal(res.status, 0);
    assert.equal(readQueue(home).length, 0);
  } finally {
    cleanup();
  }
});

test('main (--session-end) dispatches to capture for a still-running session', () => {
  const { home, cleanup } = withTempHome();
  try {
    // given — a session without a shutdown event yet, plus the matching hook payload
    writeSession(home, 'sess-running', { events: [{ type: 'session.start' }] });
    const input = JSON.stringify({ sessionId: 'sess-running' });

    // when
    const res = runHookProcess(['--session-end'], { home, input, env: NO_POLL });

    // then — clean exit; nothing captured (so the spawned capture/flush is a no-op)
    assert.equal(res.status, 0);
    assert.equal(readQueue(home).length, 0);
    assert.equal(fs.existsSync(path.join(capturedDir(home), 'sess-running')), false);
  } finally {
    cleanup();
  }
});
