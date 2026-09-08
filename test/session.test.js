'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { inSandbox, writeSession } = require('./helpers.js');

const DAY_MS = 24 * 60 * 60 * 1000;

// Capture the modes onSessionStart/onSessionEnd would spawn, without launching
// real processes. Records the full argv array per spawn.
const recordSpawns = () => {
  const spawns = [];
  return { spawns, spawnFn: (...args) => spawns.push(args) };
};

const shutdown = () => ({
  currentModel: 'gpt-5.4-mini',
  modelMetrics: {
    'gpt-5.4-mini': {
      requests: { count: 1, cost: 0.1 },
      usage: { cacheWriteTokens: 0, reasoningTokens: 0 },
      totalNanoAiu: 1,
      tokenDetails: { input: { tokenCount: 1 }, output: { tokenCount: 1 }, cache_read: { tokenCount: 1 } },
    },
  },
});

test('onSessionStart spawns a sweep carrying the current session id', () => {
  inSandbox(hook => {
    // given — no config (no update check)
    const { spawns, spawnFn } = recordSpawns();

    // when
    hook.onSessionStart({ sessionId: 'cur' }, spawnFn);

    // then — the sweep runs and is told which session to skip
    assert.deepEqual(spawns[0], ['--sweep', 'cur']);
  });
});

test('onSessionStart does not check for updates without a currentVersion', () => {
  inSandbox(hook => {
    // given — config exists but carries no version
    hook.saveConfig({ lastUpdateCheck: null });
    const { spawns, spawnFn } = recordSpawns();

    // when
    hook.onSessionStart({ sessionId: 'cur' }, spawnFn);

    // then — sweep only, no --update
    assert.deepEqual(spawns.map(s => s[0]), ['--sweep']);
  });
});

test('onSessionStart spawns an update when no check has run yet', () => {
  inSandbox(hook => {
    // given — a known version, never checked
    hook.saveConfig({ currentVersion: '0.2.0' });
    const { spawns, spawnFn } = recordSpawns();

    // when
    hook.onSessionStart({ sessionId: 'cur' }, spawnFn);

    // then — both sweep and the update probe
    assert.deepEqual(spawns.map(s => s[0]), ['--sweep', '--update']);
  });
});

test('onSessionStart skips the update when the last check is younger than 24h', () => {
  inSandbox(hook => {
    // given — checked one hour ago
    hook.saveConfig({
      currentVersion: '0.2.0',
      lastUpdateCheck: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    const { spawns, spawnFn } = recordSpawns();

    // when
    hook.onSessionStart({ sessionId: 'cur' }, spawnFn);

    // then — sweep only, update gated by the 24h interval
    assert.deepEqual(spawns.map(s => s[0]), ['--sweep']);
  });
});

test('onSessionStart spawns an update when the last check is older than 24h', () => {
  inSandbox(hook => {
    // given — checked just over a day ago
    hook.saveConfig({
      currentVersion: '0.2.0',
      lastUpdateCheck: new Date(Date.now() - DAY_MS - 1000).toISOString(),
    });
    const { spawns, spawnFn } = recordSpawns();

    // when
    hook.onSessionStart({ sessionId: 'cur' }, spawnFn);

    // then — interval elapsed, update re-probed
    assert.deepEqual(spawns.map(s => s[0]), ['--sweep', '--update']);
  });
});

test('onSessionEnd spawns a detached capture for the ended session, never inline', () => {
  inSandbox((hook, home) => {
    // given — a session that has already written its shutdown event
    writeSession(home, 'ending', { shutdownData: shutdown() });
    const { spawns, spawnFn } = recordSpawns();

    // when
    hook.onSessionEnd({ sessionId: 'ending' }, spawnFn);

    // then — capture is deferred to the detached --capture process, not done inline
    // (the shutdown event is written only after this hook returns in production)
    assert.deepEqual(spawns, [['--capture', 'ending']]);
    assert.equal(hook.isCaptured('ending'), false);
    assert.equal(hook.getQueueFiles().length, 0);
  });
});

test('onSessionEnd spawns capture with an empty id when none is provided', () => {
  inSandbox(hook => {
    // given — a hook payload with no sessionId
    const { spawns, spawnFn } = recordSpawns();

    // when
    hook.onSessionEnd({}, spawnFn);

    // then — still spawned (captureWithPoll falls through to a plain flush)
    assert.deepEqual(spawns, [['--capture', '']]);
  });
});
