'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { withTempHome, loadStatusline, runStatuslineProcess, queueDir, pluginDir, configPath } = require('./helpers.js');

const statusline = require('../statusline.js');

test('getQueueStatus: empty when the queue dir does not exist', () => {
  // given / when / then
  assert.deepEqual(statusline.getQueueStatus('/does/not/exist', Date.now()), { count: 0, oldestAgeMs: 0 });
});

test('getQueueStatus: counts files and finds the oldest by its timestamp prefix', () => {
  const { home, cleanup } = withTempHome();
  try {
    // given — copilot's queue filenames are `<timestamp>-<pid>-<counter>.json`
    const dir = queueDir(home);
    fs.mkdirSync(dir, { recursive: true });
    const now = 1_000_000_000_000;
    fs.writeFileSync(path.join(dir, `${now - 5000}-111-0.json`), '{}');
    fs.writeFileSync(path.join(dir, `${now - 1000}-111-1.json`), '{}');
    fs.writeFileSync(path.join(dir, '.lock'), '');

    // when
    const status = statusline.getQueueStatus(dir, now);

    // then — hidden/lock file excluded, oldest entry's age reported
    assert.equal(status.count, 2);
    assert.equal(status.oldestAgeMs, 5000);
  } finally {
    cleanup();
  }
});

test('hasRecentError: false when the log does not exist, true within the threshold', () => {
  const { home, cleanup } = withTempHome();
  try {
    // given
    const dir = pluginDir(home);
    fs.mkdirSync(dir, { recursive: true });
    const logPath = path.join(dir, 'error.log');

    // when / then — missing file
    assert.equal(statusline.hasRecentError(logPath, Date.now(), 1000), false);

    // when / then — freshly written
    fs.writeFileSync(logPath, 'boom');
    assert.equal(statusline.hasRecentError(logPath, Date.now(), 60_000), true);
    assert.equal(statusline.hasRecentError(logPath, Date.now() + 120_000, 60_000), false);
  } finally {
    cleanup();
  }
});

test('hasException: false when missing or empty, true once written', () => {
  const { home, cleanup } = withTempHome();
  try {
    // given
    const dir = pluginDir(home);
    fs.mkdirSync(dir, { recursive: true });
    const exceptionsPath = path.join(dir, 'exceptions.txt');

    // when / then — missing file
    assert.equal(statusline.hasException(exceptionsPath), false);

    // when / then — present but empty (cleared)
    fs.writeFileSync(exceptionsPath, '');
    assert.equal(statusline.hasException(exceptionsPath), false);

    // when / then — non-empty
    fs.writeFileSync(exceptionsPath, 'boom');
    assert.equal(statusline.hasException(exceptionsPath), true);
  } finally {
    cleanup();
  }
});

test('formatTokens', () => {
  // given / when / then
  assert.equal(statusline.formatTokens(500), '500');
  assert.equal(statusline.formatTokens(1500), '1.5k');
  assert.equal(statusline.formatTokens(2_500_000), '2.5M');
});

test('formatAge', () => {
  // given / when / then
  assert.equal(statusline.formatAge(30 * 60 * 1000), '1h');
  assert.equal(statusline.formatAge(5 * 60 * 60 * 1000), '5h');
  assert.equal(statusline.formatAge(2 * 24 * 60 * 60 * 1000), '2d');
});

test('formatModelName: prefers display_name, falls back to id, then Unknown', () => {
  // given / when / then
  assert.equal(statusline.formatModelName('GPT-5.4', 'gpt-5.4'), 'GPT-5.4');
  assert.equal(statusline.formatModelName(undefined, 'gpt-5.4'), 'gpt-5.4');
  assert.equal(statusline.formatModelName(undefined, undefined), 'Unknown model');
  assert.equal(statusline.formatModelName(null, null), 'Unknown model');
});

test('normalizeUsedPct: clamps and rounds, guards non-numeric input', () => {
  // given / when / then
  assert.equal(statusline.normalizeUsedPct(42.6), 43);
  assert.equal(statusline.normalizeUsedPct(-5), 0);
  assert.equal(statusline.normalizeUsedPct(150), 100);
  assert.equal(statusline.normalizeUsedPct(undefined), 0);
  assert.equal(statusline.normalizeUsedPct('not a number'), 0);
});

test('formatPrice', () => {
  // given / when / then — dollars, not cents (Copilot's total_nano_aiu already resolves
  // to whole dollars once divided by 1e9)
  assert.equal(statusline.formatPrice(0), '$0.00');
  assert.equal(statusline.formatPrice(1.0), '$1.00');
  assert.equal(statusline.formatPrice(12.3), '$12.30');
});

test('readPluginVersion: reads currentVersion from config.json, "unknown" when absent/corrupt', () => {
  const { home, cleanup } = withTempHome();
  try {
    // given — a fresh module load so its PLUGIN_DIR constant resolves inside the sandbox
    const sandboxed = loadStatusline();
    assert.equal(sandboxed.readPluginVersion(), 'unknown');

    // when — config written
    fs.mkdirSync(pluginDir(home), { recursive: true });
    fs.writeFileSync(configPath(home), JSON.stringify({ currentVersion: '0.7.0' }));

    // then
    assert.equal(sandboxed.readPluginVersion(), '0.7.0');
  } finally {
    cleanup();
  }
});

test('buildStatusLine: renders sync/health, context bar, and price from the given fields', () => {
  // given
  const line = statusline.buildStatusLine({
    modelName: 'gpt-5.4',
    queue: { count: 0, oldestAgeMs: 0 },
    recentError: false,
    contextPct: 42,
    version: '0.7.0',
    inputTokens: 1500,
    outputTokens: 2500,
    priceDollars: 1.2345,
  });

  // when / then
  assert.match(line, /gpt-5\.4/);
  assert.match(line, /synced/);
  assert.match(line, /42%/);
  assert.match(line, /v0\.7\.0/);
  assert.match(line, /1\.5k ↑/);
  assert.match(line, /2\.5k ↓/);
  assert.match(line, /\$1\.23/);
});

test('buildStatusLine: shows queued count when the queue is non-empty', () => {
  // given / when
  const line = statusline.buildStatusLine({
    modelName: 'gpt-5.4', queue: { count: 3, oldestAgeMs: 1000 }, recentError: false,
    contextPct: 10, version: '0.7.0', inputTokens: 0, outputTokens: 0, priceDollars: 0,
  });

  // then
  assert.match(line, /3 queued/);
});

test('buildStatusLine: shows an error state when a recent error coincides with a queue backlog', () => {
  // given / when
  const line = statusline.buildStatusLine({
    modelName: 'gpt-5.4', queue: { count: 2, oldestAgeMs: 1000 }, recentError: true,
    contextPct: 10, version: '0.7.0', inputTokens: 0, outputTokens: 0, priceDollars: 0,
  });

  // then
  assert.match(line, /2 queued/);
});

test('buildStatusLine: an exception overrides sync/queued/error segments and stays regardless of queue state', () => {
  // given / when
  const line = statusline.buildStatusLine({
    modelName: 'gpt-5.4', queue: { count: 0, oldestAgeMs: 0 }, recentError: false, exception: true,
    contextPct: 10, version: '0.7.0', inputTokens: 0, outputTokens: 0, priceDollars: 0,
  });

  // then
  assert.match(line, /exception — see exceptions\.txt/);
});

test('main() shows the exception state when exceptions.txt is present and non-empty', () => {
  const { home, cleanup } = withTempHome();
  try {
    // given
    fs.mkdirSync(pluginDir(home), { recursive: true });
    fs.writeFileSync(path.join(pluginDir(home), 'exceptions.txt'), 'boom');

    // when
    const result = runStatuslineProcess('{}', { home });

    // then
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /exception — see exceptions\.txt/);
  } finally {
    cleanup();
  }
});

test('main() reads the stdin payload and writes a status line to stdout', () => {
  const { home, cleanup } = withTempHome();
  try {
    // given — a realistic (documented, experimental) Copilot statusLine payload
    const payload = JSON.stringify({
      model: { id: 'gpt-5.4', display_name: 'GPT-5.4' },
      context_window: {
        total_input_tokens: 1200,
        total_output_tokens: 800,
        current_context_used_percentage: 17,
      },
      cost: { total_nano_aiu: 50_000_000 },
    });

    // when
    const result = runStatuslineProcess(payload, { home });

    // then
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /GPT-5\.4/);
    assert.match(result.stdout, /17%/);
    assert.match(result.stdout, /1\.2k ↑/);
    assert.match(result.stdout, /800 ↓/);
    assert.match(result.stdout, /\$0\.05/);
  } finally {
    cleanup();
  }
});

test('main() tolerates missing/malformed stdin without throwing', () => {
  const { home, cleanup } = withTempHome();
  try {
    // given / when
    const result = runStatuslineProcess('not json', { home });

    // then — still renders a line from local plugin state alone
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Unknown model/);
  } finally {
    cleanup();
  }
});
