'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOK_PATH = require.resolve('../hook.js');
const UPDATER_PATH = require.resolve('../updater.js');
const STATUSLINE_PATH = require.resolve('../statusline.js');

// Create an isolated temp directory and point $HOME at it, so the plugin's
// ~/.copilot/* path constants (computed at module load from os.homedir()) resolve
// inside the sandbox. Returns { home, cleanup }.
function withTempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tup-copilot-test-'));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home; // Windows fallback for os.homedir()

  function cleanup() {
    process.env.HOME = prevHome;
    process.env.USERPROFILE = prevUserProfile;
    fs.rmSync(home, { recursive: true, force: true });
  }
  return { home, cleanup };
}

// Load a fresh copy of hook.js so its module-level path constants pick up the
// current $HOME. Must be called AFTER withTempHome().
function loadHook() {
  delete require.cache[HOOK_PATH];
  return require(HOOK_PATH);
}

const pluginDir = home => path.join(home, '.copilot', 'tokendashboard-plugin');
const queueDir = home => path.join(pluginDir(home), 'queue');
const capturedDir = home => path.join(pluginDir(home), 'captured');
const skippedDir = home => path.join(pluginDir(home), 'skipped');
const deadLetterDir = home => path.join(pluginDir(home), 'dead-letter');
const sessionStateDir = home => path.join(home, '.copilot', 'session-state');
const settingsPath = home => path.join(home, '.copilot', 'settings.json');
const hookDest = home => path.join(home, '.copilot', 'hooks', 'tokendashboard-plugin.js');
const configPath = home => path.join(pluginDir(home), 'config.json');

// Write a session-state dir with an events.jsonl containing the given event lines.
// `shutdownData` (when provided) is wrapped in a single session.shutdown event and appended.
function writeSession(home, sessionId, { events = [], shutdownData, timestamp } = {}) {
  const dir = path.join(sessionStateDir(home), sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const lines = events.map(e => JSON.stringify(e));
  if (shutdownData !== undefined) {
    lines.push(JSON.stringify({
      type: 'session.shutdown',
      data: shutdownData,
      timestamp: timestamp ?? '2026-06-09T11:32:23.530Z',
    }));
  }
  fs.writeFileSync(path.join(dir, 'events.jsonl'), lines.join('\n') + (lines.length ? '\n' : ''));
  return dir;
}

// Load a fresh copy of statusline.js so its module-level path constants (PLUGIN_DIR etc.,
// used by readPluginVersion) pick up the current $HOME. Must be called AFTER withTempHome().
function loadStatusline() {
  delete require.cache[STATUSLINE_PATH];
  return require(STATUSLINE_PATH);
}

// Load a fresh copy of updater.js so its module-level path constants pick up the
// current $HOME. Must be called AFTER withTempHome().
function loadCli() {
  delete require.cache[UPDATER_PATH];
  return require(UPDATER_PATH);
}

// Run fn against a freshly loaded cli module inside an isolated temp $HOME, with
// console.log muted (install/uninstall are chatty). fn receives (cli, home).
function inCliSandbox(fn) {
  const { home, cleanup } = withTempHome();
  const cli = loadCli();
  const origLog = console.log;
  console.log = () => {};
  try {
    return fn(cli, home);
  } finally {
    console.log = origLog;
    cleanup();
  }
}

// Async variant of inCliSandbox — awaits fn before cleanup, so tests exercising
// updater.js's async converge() don't tear down the sandbox out from under it.
async function inCliSandboxAsync(fn) {
  const { home, cleanup } = withTempHome();
  const cli = loadCli();
  const origLog = console.log;
  console.log = () => {};
  try {
    return await fn(cli, home);
  } finally {
    console.log = origLog;
    cleanup();
  }
}

// Run fn against a freshly loaded hook module inside an isolated temp $HOME,
// guaranteeing cleanup. fn receives (hook, home).
function inSandbox(fn) {
  const { home, cleanup } = withTempHome();
  const hook = loadHook();
  try {
    return fn(hook, home);
  } finally {
    cleanup();
  }
}

// Async variant of inSandbox. With { hookCopy: true } the module is loaded from
// a COPY inside the sandbox, so its __filename (and thus doUpdate's self-write
// target) points at the copy — the real hook.js is never overwritten.
// fn receives (hook, home, hookPath).
async function inSandboxAsync(fn, opts = {}) {
  const { home, cleanup } = withTempHome();
  let hookPath = HOOK_PATH;
  if (opts.hookCopy) {
    hookPath = path.join(home, 'hook-under-test.js');
    fs.copyFileSync(HOOK_PATH, hookPath);
  }
  delete require.cache[hookPath];
  const hook = require(hookPath);
  try {
    return await fn(hook, home, hookPath);
  } finally {
    cleanup();
  }
}

// Replace global.fetch with a recording stub for the duration of a test.
// handler(url, options, callIndex) returns a Response-like object, or throws to
// simulate a network failure (which hook.js's fetchWithTimeout maps to null).
// Returns { calls, restore }.
function stubFetch(handler) {
  const prev = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return handler(url, options, calls.length - 1);
  };
  return { calls, restore: () => {
    global.fetch = prev;
  } };
}

// Run the real hook.js as a child process (exercising main()'s argv dispatch and
// stdin handling) with $HOME pointed at the sandbox. Returns the spawnSync result
// ({ status, stdout, stderr }). Only use with network-safe modes.
function runHookProcess(args, { home, input = '', env = {} } = {}) {
  return spawnSync(process.execPath, [HOOK_PATH, ...args], {
    input,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, ...env },
  });
}

// Run the real statusline.js as a child process, piping a JSON stdin payload, with
// $HOME pointed at the sandbox. Returns the spawnSync result ({ status, stdout, stderr }).
function runStatuslineProcess(input, { home }) {
  return spawnSync(process.execPath, [STATUSLINE_PATH], {
    input,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
}

module.exports = {
  withTempHome,
  loadHook,
  loadCli,
  loadStatusline,
  inSandbox,
  inSandboxAsync,
  inCliSandbox,
  inCliSandboxAsync,
  stubFetch,
  runHookProcess,
  runStatuslineProcess,
  writeSession,
  pluginDir,
  queueDir,
  capturedDir,
  skippedDir,
  deadLetterDir,
  sessionStateDir,
  settingsPath,
  hookDest,
  configPath,
};
