'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { inSandbox, inSandboxAsync, stubFetch, writeSession, capturedDir } = require('./helpers.js');

// A realistic single-model session.shutdown payload (shape mirrors real Copilot data).
function singleModelShutdown() {
  return {
    currentModel: 'gpt-5.4-mini',
    totalPremiumRequests: 2.97,
    totalNanoAiu: 17313600000,
    tokenDetails: {
      input: { tokenCount: 76668 },
      cache_read: { tokenCount: 739840 },
      output: { tokenCount: 13366 },
    },
    modelMetrics: {
      'gpt-5.4-mini': {
        requests: { count: 31, cost: 2.97 },
        usage: {
          inputTokens: 816508,
          outputTokens: 13366,
          cacheReadTokens: 739840,
          cacheWriteTokens: 12,
          reasoningTokens: 9773,
        },
        totalNanoAiu: 17313600000,
        tokenDetails: {
          input: { tokenCount: 76668 },
          cache_read: { tokenCount: 739840 },
          output: { tokenCount: 13366 },
        },
      },
    },
  };
}

const readQueue = hook => hook.getQueueFiles().map(f => JSON.parse(fs.readFileSync(f, 'utf8')));

test('captureSession returns false when the session has no events.jsonl', () => {
  inSandbox((hook, home) => {
    // given — no session dir
    fs.mkdirSync(path.join(home, '.copilot', 'session-state'), { recursive: true });

    // when
    const captured = hook.captureSession('missing');

    // then — 0 shutdowns newly captured
    assert.equal(captured, 0);
    assert.equal(hook.getQueueFiles().length, 0);
  });
});

test('captureSession rejects a sessionId containing a path separator', () => {
  inSandbox((hook, home) => {
    // given — a sessionId crafted to escape SESSION_STATE_DIR
    // when
    const captured = hook.captureSession('../../etc/passwd');

    // then — treated as "nothing to capture", not resolved as a path, but recorded as
    // an exception (this should never happen) rather than silently dropped
    assert.equal(captured, 0);
    const exceptionsPath = path.join(home, '.copilot', 'tokendashboard-plugin', 'exceptions.txt');
    assert.match(fs.readFileSync(exceptionsPath, 'utf8'), /unsafe sessionId/);
  });
});

test('captureSession returns false while the session has no shutdown event yet', () => {
  inSandbox((hook, home) => {
    // given — a running session (events but no session.shutdown)
    writeSession(home, 'sess-running', { events: [{ type: 'session.start' }] });

    // when
    const captured = hook.captureSession('sess-running');

    // then — nothing queued, not marked captured
    assert.equal(captured, 0);
    assert.equal(hook.getQueueFiles().length, 0);
    assert.equal(hook.isCaptured('sess-running'), false);
  });
});

test('captureSession writes one entry from the model breakdown and marks it captured', () => {
  inSandbox((hook, home) => {
    // given — a finished single-model session
    writeSession(home, 'sess-1', { shutdownData: singleModelShutdown() });

    // when
    const captured = hook.captureSession('sess-1');

    // then — one entry split into input vs cache_read, with copilot-specific fields
    assert.equal(captured, 1); // one shutdown newly captured
    const entries = readQueue(hook);
    assert.equal(entries.length, 1);
    const e = entries[0];
    assert.equal(e.session_id, 'sess-1');
    assert.equal(e.model, 'gpt-5.4-mini');
    assert.equal(e.usage.input_tokens, 76668);
    assert.equal(e.usage.output_tokens, 13366);
    assert.equal(e.usage.cache_read_tokens, 739840);
    assert.equal(e.usage.cache_write_tokens, 12);
    assert.equal(e.usage.reasoning_tokens, 9773);
    assert.equal(e.requests, 31);
    assert.equal(e.total_nano_aiu, 17313600000);
    assert.equal(e.total_premium_requests, 2.97);
    assert.equal(fs.existsSync(path.join(capturedDir(home), 'sess-1')), true);
  });
});

test('captureSession writes one entry per model on a model switch', () => {
  inSandbox((hook, home) => {
    // given — a session that used two models
    writeSession(home, 'sess-multi', {
      shutdownData: {
        currentModel: 'gpt-5.4',
        modelMetrics: {
          'gpt-5.4-mini': {
            requests: { count: 5, cost: 0.5 },
            usage: { cacheWriteTokens: 1, reasoningTokens: 2 },
            totalNanoAiu: 100,
            tokenDetails: { input: { tokenCount: 10 }, output: { tokenCount: 20 }, cache_read: { tokenCount: 30 } },
          },
          'gpt-5.4': {
            requests: { count: 7, cost: 1.5 },
            usage: { cacheWriteTokens: 3, reasoningTokens: 4 },
            totalNanoAiu: 200,
            tokenDetails: { input: { tokenCount: 40 }, output: { tokenCount: 50 }, cache_read: { tokenCount: 60 } },
          },
        },
      },
    });

    // when
    hook.captureSession('sess-multi');

    // then — one entry per model, each with its own tokens
    const byModel = Object.fromEntries(readQueue(hook).map(e => [e.model, e]));
    assert.deepEqual(Object.keys(byModel).sort(), ['gpt-5.4', 'gpt-5.4-mini']);
    assert.equal(byModel['gpt-5.4-mini'].usage.input_tokens, 10);
    assert.equal(byModel['gpt-5.4-mini'].requests, 5);
    assert.equal(byModel['gpt-5.4'].usage.output_tokens, 50);
    assert.equal(byModel['gpt-5.4'].total_premium_requests, 1.5);
  });
});

test('captureSession falls back to session totals when modelMetrics is empty', () => {
  inSandbox((hook, home) => {
    // given — a shutdown with no per-model breakdown
    writeSession(home, 'sess-empty', {
      shutdownData: {
        currentModel: 'gpt-5.4-mini',
        totalNanoAiu: 999,
        totalPremiumRequests: 1.1,
        tokenDetails: {
          input: { tokenCount: 5 },
          output: { tokenCount: 6 },
          cache_read: { tokenCount: 7 },
          cache_write: { tokenCount: 8 },
        },
        modelMetrics: {},
      },
    });

    // when
    const captured = hook.captureSession('sess-empty');

    // then — a single fallback entry from the session-level totals
    assert.equal(captured, 1);
    const entries = readQueue(hook);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].model, 'gpt-5.4-mini');
    assert.equal(entries[0].usage.input_tokens, 5);
    assert.equal(entries[0].usage.cache_read_tokens, 7);
    // cache_write comes from session-level tokenDetails, not hardcoded 0
    assert.equal(entries[0].usage.cache_write_tokens, 8);
    assert.equal(entries[0].total_nano_aiu, 999);
    assert.equal(entries[0].total_premium_requests, 1.1);
  });
});

test('captureSession marks a shutdown event that is missing its data field', () => {
  inSandbox((hook, home) => {
    // given — a malformed shutdown event with no data field (would throw without the
    // `event.data ?? {}` guard, leaving the session re-read on every sweep)
    writeSession(home, 'sess-nodata', {
      events: [{ type: 'session.shutdown', timestamp: '2026-06-09T11:32:23.530Z' }],
    });

    // when
    const captured = hook.captureSession('sess-nodata');

    // then — captured via the fallback path, marked, and a single zeroed entry queued
    assert.equal(captured, 1);
    assert.equal(hook.isCaptured('sess-nodata'), true);
    const entries = readQueue(hook);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].model, 'unknown');
    assert.equal(entries[0].usage.input_tokens, 0);
  });
});

test('captureSession does not re-queue an already-captured session', () => {
  inSandbox((hook, home) => {
    // given — a finished session plus a presence marker from an earlier capture
    writeSession(home, 'already', { shutdownData: singleModelShutdown() });
    fs.mkdirSync(capturedDir(home), { recursive: true });
    fs.writeFileSync(path.join(capturedDir(home), 'already'), '');

    // when
    const captured = hook.captureSession('already');

    // then — presence alone blocks re-capture, no entry queued
    assert.equal(captured, 0);
    assert.equal(hook.getQueueFiles().length, 0);
  });
});

test('sweep captures every uncaptured session except the current one', () => {
  inSandbox((hook, home) => {
    // given — two finished sessions plus the currently running one
    writeSession(home, 'old-1', { shutdownData: singleModelShutdown() });
    writeSession(home, 'old-2', { shutdownData: singleModelShutdown() });
    writeSession(home, 'current', { shutdownData: singleModelShutdown() });

    // when
    hook.sweep('current');

    // then — old sessions captured, the current one skipped
    assert.equal(hook.isCaptured('old-1'), true);
    assert.equal(hook.isCaptured('old-2'), true);
    assert.equal(hook.isCaptured('current'), false);
    assert.equal(hook.getQueueFiles().length, 2);
  });
});

test('sweep does not re-capture an already-captured session', () => {
  inSandbox((hook, home) => {
    // given — a session already captured once
    writeSession(home, 'done', { shutdownData: singleModelShutdown() });
    hook.captureSession('done');
    assert.equal(hook.getQueueFiles().length, 1);

    // when — a later sweep runs
    hook.sweep('current');

    // then — no duplicate entry is produced
    assert.equal(hook.getQueueFiles().length, 1);
  });
});

// captureWithPoll's trailing flush is stubbed to a network error so it leaves entries
// queued — letting these tests assert what was captured without a real request.
const offline = () => stubFetch(() => {
  throw new Error('offline');
});

test('captureWithPoll captures on the first attempt when the shutdown is already written', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given — a finished session and a sleepFn that must never be needed
    writeSession(home, 'ended', { shutdownData: singleModelShutdown() });
    let sleeps = 0;
    const { restore } = offline();

    // when
    try {
      await hook.captureWithPoll('ended', { intervalMs: 1, timeoutMs: 10, sleepFn: async () => {
        sleeps++;
      } });
    } finally {
      restore();
    }

    // then — captured without ever polling, entry left queued by the failed flush
    assert.equal(hook.isCaptured('ended'), true);
    assert.equal(hook.getQueueFiles().length, 1);
    assert.equal(sleeps, 0);
  });
});

test('captureWithPoll polls until the shutdown event appears, then captures', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given — a still-running session; the shutdown lands while we are sleeping
    writeSession(home, 'late', { events: [{ type: 'session.start' }] });
    let sleeps = 0;
    const sleepFn = async () => {
      sleeps++;
      writeSession(home, 'late', { shutdownData: singleModelShutdown() });
    };
    const { restore } = offline();

    // when
    try {
      await hook.captureWithPoll('late', { intervalMs: 1, timeoutMs: 10, sleepFn });
    } finally {
      restore();
    }

    // then — captured after the shutdown appeared mid-poll
    assert.equal(hook.isCaptured('late'), true);
    assert.equal(hook.getQueueFiles().length, 1);
    assert.equal(sleeps, 1);
  });
});

test('captureWithPoll gives up after the timeout when no shutdown is ever written', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given — a session that never writes a shutdown event
    writeSession(home, 'stuck', { events: [{ type: 'session.start' }] });
    let sleeps = 0;

    // when — 3 attempts (timeout/interval), so 2 sleeps between them
    await hook.captureWithPoll('stuck', { intervalMs: 1, timeoutMs: 3, sleepFn: async () => {
      sleeps++;
    } });

    // then — nothing captured; the sweep remains the backstop
    assert.equal(hook.isCaptured('stuck'), false);
    assert.equal(hook.getQueueFiles().length, 0);
    assert.equal(sleeps, 2);
  });
});

test('captureWithPoll does not re-capture an already-captured session', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given — a session captured by an earlier sweep
    writeSession(home, 'already', { shutdownData: singleModelShutdown() });
    hook.markCaptured('already');

    // when
    await hook.captureWithPoll('already', { intervalMs: 1, timeoutMs: 10, sleepFn: async () => {} });

    // then — already captured, short-circuited before polling, no duplicate entry
    assert.equal(hook.getQueueFiles().length, 0);
  });
});
