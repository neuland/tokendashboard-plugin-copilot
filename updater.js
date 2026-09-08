#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');

// updater.js carries all lifecycle logic: install/uninstall (the npx package's `bin` entry)
// and converge (fetched fresh from the configured repo, executed via stdin by hook.js's
// loader). It is deliberately NOT a durable installed file, so a bug here ships on the next
// scheduled check rather than requiring every user to reinstall (see ADR-012).
//
// hook.js (the durable payload) contains only capture/flush/sweep plus the loader that
// fetches this file. The two share a small utility floor (atomicWriteSync,
// fetchWithTimeout, rawUrl) — duplicated by design rather than shared via a require.

// Path of the installed hook relative to home. Used both as the filesystem copy
// destination (joined onto os.homedir()) and, in POSIX form, inside the hook command.
const HOOK_REF = '.copilot/hooks/tokendashboard-plugin.js';
const HOOK_DEST = path.join(os.homedir(), ...HOOK_REF.split('/'));
const SETTINGS_PATH = path.join(os.homedir(), '.copilot', 'settings.json');
const PLUGIN_DIR = path.join(os.homedir(), '.copilot', 'tokendashboard-plugin');
const CONFIG_PATH = path.join(PLUGIN_DIR, 'config.json');
const LOG_PATH = path.join(PLUGIN_DIR, 'error.log');

// statusline.js lives alongside the plugin's data dir and is a pluginFile like hook.js —
// auto-updated via converge (see package.json).
const STATUSLINE_DEST = path.join(PLUGIN_DIR, 'statusline.js');
const STATUSLINE_REF = 'tokendashboard-plugin/statusline.js';
const STATUSLINE_COMMAND = `node "$HOME/.copilot/${STATUSLINE_REF}"`;
// statusLine is a single settings.json slot, not a list like the hook events below, so
// there is no way to have both a foreign one and ours installed at once — a pre-existing
// foreign entry (the user's own, or another plugin's) is matched by the full
// `.copilot/<dir>/statusline.js` path suffix (not just the basename — a bare "statusline.js"
// match would also claim an unrelated tool's same-named script, or a stale entry left over
// from an old plugin directory name) and left untouched rather than clobbered.
const STATUSLINE_MATCH = `.copilot/${STATUSLINE_REF}`;

// Update lock — separate from the flush queue's own lock (which lives under
// ~/.copilot/tokendashboard-plugin/queue/.lock, inside hook.js). converge holds this across
// a slow network fetch and must not block a concurrent sessionEnd flush.
const UPDATE_LOCK_FILE = path.join(PLUGIN_DIR, 'update.lock');

const TIMEOUT_MS = 5000;
const HOOK_FETCH_TIMEOUT_MS = 10000;

// Hook is referenced via `$HOME`, not an absolute path, so the same settings.json works
// under a different home (e.g. a devcontainer mounting the host `~/.copilot`) — see
// ADR-009. Node is invoked by bare name so it resolves via PATH (nvm/mise/asdf) and
// survives a Node upgrade without a reinstall.
//
// The `bash` key additionally prefixes `command ` to work around the JetBrains/IntelliJ
// Copilot harness rewriting a leading `node` token to a spaced, unquoted path (see
// ADR-010). PowerShell has no such rewrite, so its key and the cross-platform `command`
// fallback keep bare `node`.
const SESSION_START_BASH = `command node "$HOME/${HOOK_REF}" --session-start`;
const SESSION_END_BASH = `command node "$HOME/${HOOK_REF}" --session-end`;
const SESSION_START_SHELL = `node "$HOME/${HOOK_REF}" --session-start`;
const SESSION_END_SHELL = `node "$HOME/${HOOK_REF}" --session-end`;

const HOOK_DEFS = [
  { event: 'sessionStart', bash: SESSION_START_BASH, shell: SESSION_START_SHELL },
  { event: 'sessionEnd',   bash: SESSION_END_BASH,   shell: SESSION_END_SHELL },
];

function readSettings() {
  if (!fs.existsSync(SETTINGS_PATH)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  } catch {
    console.error(`Error: Could not parse ${SETTINGS_PATH}`);
    process.exit(1);
  }
}

function writeSettings(settings) {
  atomicWriteSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
}

function atomicWriteSync(filePath, content) {
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  fs.chmodSync(filePath, 0o600);
}

// Match by the HOOK_REF suffix so both the `$HOME`-relative form and any legacy absolute
// path are recognized. Copilot persists our entry as per-shell keys (`bash`/`powershell`)
// that may omit `command` entirely, so scan every string value of the entry rather than
// only `entry.command` — otherwise uninstall/reinstall would fail to recognize it.
function removeOwnHooks(hookList) {
  return hookList.filter(entry =>
    !Object.values(entry).some(v => typeof v === 'string' && v.includes(HOOK_REF)));
}

// Apply our two hook entries idempotently: strip any existing (ours) entries per event,
// then push the current desired command. Foreign hooks and unrelated settings keys are
// preserved.
function patchSettings(settings) {
  settings.hooks ??= {};
  for (const { event, bash, shell } of HOOK_DEFS) {
    settings.hooks[event] = removeOwnHooks(settings.hooks[event] ?? []);
    settings.hooks[event].push({ type: 'command', bash, powershell: shell, command: shell });
  }
  return settings;
}

// Scoped drift check: are OUR entries already exactly correct? Compares only values
// matching HOOK_REF, so unrelated key reordering or foreign hooks never read as drift —
// this is what lets converge perform zero settings writes in steady state. A field
// Copilot didn't persist (see removeOwnHooks) is not drift, only a wrong one is.
function hooksAreCurrent(settings) {
  for (const { event, bash, shell } of HOOK_DEFS) {
    const entries = settings.hooks?.[event] ?? [];
    const ours = entries.filter(entry =>
      Object.values(entry).some(v => typeof v === 'string' && v.includes(HOOK_REF)));
    if (ours.length !== 1) {
      return false;
    }
    const entry = ours[0];
    if ((entry.bash !== undefined && entry.bash !== bash)
      || (entry.powershell !== undefined && entry.powershell !== shell)
      || (entry.command !== undefined && entry.command !== shell)) {
      return false;
    }
  }
  return true;
}

function installStatusLine(settings) {
  const existing = settings.statusLine;
  if (existing?.command && !existing.command.includes(STATUSLINE_MATCH)) {
    console.log('Existing statusLine found — leaving it untouched. To use this plugin\'s statusline, add manually:');
    console.log(`  ${STATUSLINE_COMMAND}`);
    return;
  }
  settings.statusLine = { type: 'command', command: STATUSLINE_COMMAND };
}

function uninstallStatusLine(settings) {
  if (settings.statusLine?.command?.includes(STATUSLINE_MATCH)) {
    delete settings.statusLine;
  }
}

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
  fs.mkdirSync(PLUGIN_DIR, { recursive: true });
  atomicWriteSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function logError(context, err) {
  try {
    fs.mkdirSync(PLUGIN_DIR, { recursive: true });
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} [${context}] ${err}\n`);
  } catch {}
}

// --- HTTP ---

async function fetchWithTimeout(url, options = {}, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// --- Semver ---

function semverGt(a, b) {
  const parse = v => String(v).split('.').map(Number);
  const pa = parse(a);
  const pb = parse(b);
  // A non-numeric segment (e.g. a "0.3.0-beta" pre-release tag, or a truncated version)
  // parses to NaN, and every NaN comparison is false — which would silently report "not
  // newer" and stall the rollout with no error. Reject such input explicitly instead.
  // Missing trailing segments ("1.2") are padded with 0.
  if ([...pa, ...pb].some(Number.isNaN)) {
    return false;
  }
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) {
      return x > y;
    }
  }
  return false;
}

// --- Update lock ---

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireUpdateLock() {
  fs.mkdirSync(PLUGIN_DIR, { recursive: true });
  // Two attempts: the normal wx, then once more after unlinking a stale lock. wx is
  // atomic, so even with multiple concurrent stealers only one ever wins the retry.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(UPDATE_LOCK_FILE, String(process.pid), { flag: 'wx' });
      return true;
    } catch {
      let pid;
      try {
        pid = parseInt(fs.readFileSync(UPDATE_LOCK_FILE, 'utf8'), 10);
      } catch {
        continue; // Lock vanished between wx-fail and read — retry
      }
      // Steal the lock unless a real, live process owns it. A NaN/0 pid means the file is
      // empty or corrupt (e.g. a crash between the wx-create and the pid write) — that must
      // be stealable, or an empty update.lock would block every future update forever.
      if (Number.isInteger(pid) && pid > 0 && isProcessAlive(pid)) {
        return false;
      }
      try {
        fs.rmSync(UPDATE_LOCK_FILE);
      } catch {}
    }
  }
  return false;
}

function releaseUpdateLock() {
  try {
    fs.rmSync(UPDATE_LOCK_FILE);
  } catch {}
}

// --- Install (npx, local) ---

// The durable files to copy/fetch into the hook's directory, declared in package.json.
// hook.js is the only one today; the manifest lets a future pluginFile be added without
// touching the fetch/converge machinery. NOTE: updater.js is NOT a pluginFile — it is
// fetched fresh and never stored.
function localPluginFiles() {
  try {
    return require('./package.json').pluginFiles ?? ['hook.js'];
  } catch {
    return ['hook.js'];
  }
}

// hook.js is installed under a different on-disk name (HOOK_DEST, `tokendashboard-plugin.js`
// — a naming choice predating pluginFiles), and statusline.js lives in PLUGIN_DIR rather
// than the hooks dir. Any future pluginFile defaults to keeping its own name in hooksDir.
function pluginFileDest(hooksDir, file) {
  if (file === 'hook.js') {
    return HOOK_DEST;
  }
  if (file === 'statusline.js') {
    return STATUSLINE_DEST;
  }
  return path.join(hooksDir, file);
}

function install(apiBaseUrl, repoRawBaseUrl) {
  const hooksDir = path.dirname(HOOK_DEST);
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.mkdirSync(PLUGIN_DIR, { recursive: true });

  // Copy each payload file from the npx package dir (this module's own dir) into its
  // destination (hook.js into the hooks dir, statusline.js into PLUGIN_DIR — see
  // pluginFileDest). __dirname is only referenced here — never at module top level — so
  // a stdin-run converge (which has no meaningful __dirname and never calls install) is
  // unaffected.
  for (const file of localPluginFiles()) {
    fs.copyFileSync(path.join(__dirname, file), pluginFileDest(hooksDir, file));
  }
  console.log(`Hook installed: ${HOOK_DEST}`);
  console.log(`Statusline installed: ${STATUSLINE_DEST}`);

  const { version } = require('./package.json');
  const existingConfig = loadConfig();
  // Both flags are required on every install/reinstall (validated in main() before this
  // is ever called) and are written exactly as passed — never merged with, or falling
  // back to, a previously stored config.json value. Other unrelated fields are still
  // preserved via the spread.
  saveConfig({
    ...existingConfig,
    currentVersion: version,
    lastUpdateCheck: new Date().toISOString(),
    apiBaseUrl,
    repoRawBaseUrl,
  });
  console.log(`API base URL: ${apiBaseUrl}`);
  console.log(`Update source: ${repoRawBaseUrl}`);

  const settings = readSettings();
  patchSettings(settings);
  installStatusLine(settings);

  writeSettings(settings);
  console.log(`Settings updated: ${SETTINGS_PATH}`);
  console.log(`\nDone. Installed version ${version}.`);
}

// --- Uninstall ---

function uninstall() {
  const hadHook = fs.existsSync(HOOK_DEST);
  const hadStatusline = fs.existsSync(STATUSLINE_DEST);
  const hooksDir = path.dirname(HOOK_DEST);
  for (const file of localPluginFiles()) {
    const p = pluginFileDest(hooksDir, file);
    if (fs.existsSync(p)) {
      fs.rmSync(p);
    }
  }
  if (hadHook) {
    console.log(`Hook removed: ${HOOK_DEST}`);
  }
  if (hadStatusline) {
    console.log(`Statusline removed: ${STATUSLINE_DEST}`);
  }

  if (!fs.existsSync(SETTINGS_PATH)) {
    return;
  }

  const settings = readSettings();
  uninstallStatusLine(settings);

  if (!settings.hooks) {
    writeSettings(settings);
    console.log(`Settings updated: ${SETTINGS_PATH}`);
    console.log('\nDone. Token usage tracking removed.');
    return;
  }

  for (const event of ['sessionStart', 'sessionEnd']) {
    if (!settings.hooks[event]) {
      continue;
    }
    settings.hooks[event] = removeOwnHooks(settings.hooks[event]);
    if (settings.hooks[event].length === 0) {
      delete settings.hooks[event];
    }
  }

  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }

  writeSettings(settings);
  console.log(`Settings updated: ${SETTINGS_PATH}`);
  console.log('\nDone. Token usage tracking removed.');
}

// --- Converge (fetched-run, from hook.js's loader via stdin) ---

// Strip a trailing slash from `base` so a configured `repoRawBaseUrl` ending in `/`
// (e.g. a fork's raw-file base pasted with a trailing slash) doesn't produce a
// double-slash path like `.../main//package.json`.
const rawUrl = (base, file) => `${base.replace(/\/$/, '')}/${file}`;

// A 200 response is not proof the body is our source: a proxy/CDN/SSO gate can return
// HTTP 200 with an HTML page (often without a doctype) or a JSON error body. Writing that
// as hook.js and bumping currentVersion would wedge telemetry permanently — the next
// converge sees the version satisfied and never re-downloads. For a .js payload, compile
// it (without executing) so only parseable JavaScript is published.
function isValidPayload(file, content) {
  if (content.trimStart().startsWith('<!')) {
    return false; // HTML error page, not source
  }
  if (file.endsWith('.js')) {
    try {
      // Strip a leading shebang before compiling — hook.js begins with one, and vm.Script's
      // hashbang handling should not be relied on across engine versions.
      new vm.Script(content.replace(/^#![^\n]*\n/, ''), { filename: file });
    } catch {
      return false; // not parseable JS — a junk body served with HTTP 200
    }
  }
  return true;
}

function cleanupTmp(staged) {
  for (const { tmp } of staged) {
    try {
      fs.rmSync(tmp);
    } catch {}
  }
}

// Downloads every payload file, then publishes them. Per-file atomic (tmp + rename), but
// not atomic as a set (POSIX has no multi-file rename) — acceptable because the update
// lock serializes converge. currentVersion is bumped only after every file has landed, so
// a partial fetch leaves the version untouched and is retried next session.
async function downloadPluginFiles(pluginFiles, remoteVersion, rawBase) {
  const hooksDir = path.dirname(HOOK_DEST);
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.mkdirSync(PLUGIN_DIR, { recursive: true });
  const staged = [];
  for (const file of pluginFiles) {
    const res = await fetchWithTimeout(rawUrl(rawBase, file), {}, HOOK_FETCH_TIMEOUT_MS);
    if (!res?.ok || res.redirected) {
      cleanupTmp(staged);
      return;
    }
    let content;
    try {
      content = await res.text();
    } catch {
      cleanupTmp(staged);
      return;
    }
    if (!isValidPayload(file, content)) {
      cleanupTmp(staged); // not our source — HTML/login page or JSON error body served with 200
      return;
    }
    const dest = pluginFileDest(hooksDir, file);
    const tmp = `${dest}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, content);
    staged.push({ tmp, dest });
  }
  try {
    // A concurrent `uninstall` may have cleared currentVersion while we fetched the files.
    // Abort the publish rather than re-materializing a removed install.
    if (!loadConfig().currentVersion) {
      cleanupTmp(staged);
      return;
    }
    for (const { tmp, dest } of staged) {
      fs.renameSync(tmp, dest); // atomic per file — a reader sees old or new, never partial
    }
    saveConfig({ ...loadConfig(), currentVersion: remoteVersion });
  } catch (err) {
    // A write/rename failure (e.g. the file held open on Windows, EACCES) must not leave
    // staged .tmp files behind. Already-renamed entries are gone; cleanupTmp no-ops on them.
    cleanupTmp(staged);
    throw err;
  }
}

// Fetch and reconcile the installation to the desired state. Idempotent: with correct
// files and settings already in place it performs no writes (steady state).
async function converge() {
  const config = loadConfig();
  if (!config.currentVersion) {
    return; // Not installed — nothing to converge.
  }
  if (!acquireUpdateLock()) {
    return; // Another session is already updating (thundering-herd guard).
  }
  try {
    // repoRawBaseUrl comes only from install-time config (ADR-011), no hardcoded default.
    // Missing means "not installed" — never touch the installed files.
    const rawBase = config.repoRawBaseUrl;
    if (!rawBase) {
      return;
    }

    const pkgRes = await fetchWithTimeout(rawUrl(rawBase, 'package.json'));
    if (!pkgRes?.ok) {
      return;
    }
    let remote;
    try {
      remote = await pkgRes.json();
    } catch {
      return;
    }
    const remoteVersion = remote.version;
    if (!remoteVersion) {
      return;
    }
    const pluginFiles = Array.isArray(remote.pluginFiles) && remote.pluginFiles.length
      ? remote.pluginFiles
      : ['hook.js'];

    // Re-read config after the (slow) network round-trip: an explicit `uninstall` running
    // this session may have cleared currentVersion while converge was off fetching.
    const current = loadConfig().currentVersion;
    if (!current) {
      return;
    }

    if (semverGt(remoteVersion, current)) {
      await downloadPluginFiles(pluginFiles, remoteVersion, rawBase);
    }

    // Self-heal settings.json: repatch our hook entries and statusLine if they've drifted
    // (e.g. a manual edit, or corruption) — a pure no-op in steady state. A foreign
    // statusLine is left alone by installStatusLine itself, so it never counts as drift.
    const settings = readSettings();
    // Only an entirely absent statusLine counts as our drift to repair — a foreign one
    // (another command, or another plugin's) is deliberately left alone by
    // installStatusLine itself, so it must not force a settings write here either.
    const statusLineMissing = !settings.statusLine;
    if (settings && (!hooksAreCurrent(settings) || statusLineMissing)) {
      patchSettings(settings);
      installStatusLine(settings);
      writeSettings(settings);
    }

    // Server reachable: record the check so the loader doesn't re-probe for 24h,
    // regardless of whether an actual update followed.
    saveConfig({ ...loadConfig(), lastUpdateCheck: new Date().toISOString() });
  } catch (err) {
    logError('converge', err);
  } finally {
    releaseUpdateLock();
  }
}

// --- Entry ---

function run(command, apiBaseUrl, repoRawBaseUrl) {
  if (command === 'install') {
    install(apiBaseUrl, repoRawBaseUrl);
  } else if (command === 'uninstall') {
    uninstall();
  } else {
    console.error(`Unknown command: ${command}`);
    console.error(
      'Usage: tokendashboard-plugin-copilot install --api-base-url <url> --repo-raw-base-url <url> | uninstall');
    process.exit(1);
  }
}

// Pulls `--api-base-url <url>` or `--api-base-url=<url>` out of the raw CLI args. There
// is no hardcoded default: every deployment points at its own backend, so the value must
// come from the person installing it. It is the bare base URL only (e.g.
// `https://tokendashboard.example.com`) — the plugin appends the ingest path itself.
function parseApiBaseUrlArg(args) {
  const eq = args.find(a => a.startsWith('--api-base-url='));
  if (eq) {
    return eq.slice('--api-base-url='.length) || undefined;
  }
  const idx = args.indexOf('--api-base-url');
  if (idx !== -1) {
    return args[idx + 1];
  }
  return undefined;
}

// Pulls `--repo-raw-base-url <url>` or `--repo-raw-base-url=<url>` out of the raw CLI
// args. There is no hardcoded default: every deployment names its own update source
// (which git host serves its raw files), so the value must come from the installer,
// exactly like --api-base-url.
function parseRepoUrlArg(args) {
  const eq = args.find(a => a.startsWith('--repo-raw-base-url='));
  if (eq) {
    return eq.slice('--repo-raw-base-url='.length) || undefined;
  }
  const idx = args.indexOf('--repo-raw-base-url');
  if (idx !== -1) {
    return args[idx + 1];
  }
  return undefined;
}

// Flags that take a separate-token value (as opposed to only the `--flag=value` form).
// Command extraction below must skip that value token too, or omitting the `install`/
// `uninstall` word (e.g. `npx <pkg> --api-base-url <url>`) would misparse the URL itself
// as the command.
const VALUE_FLAGS = ['--api-base-url', '--repo-raw-base-url'];

// Rejects values that aren't a well-formed http(s) URL so a typo fails fast at install
// time instead of surfacing later as silent flush/update failures. `requirePath` is true
// for `--repo-raw-base-url`, which names a specific raw-files root (e.g.
// `https://raw.githubusercontent.com/<org>/<repo>/main`) and is never valid as a bare
// origin. `--api-base-url` is the opposite: a bare origin IS the valid form, since the
// plugin appends the ingest path itself — pass `requirePath: false` for it.
const HTTP_ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function isPlausibleUrl(value, requirePath = true) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'https:') {
      // ok
    } else if (parsed.protocol === 'http:' && HTTP_ALLOWED_HOSTS.has(parsed.hostname)) {
      // ok — local development only
    } else {
      return false;
    }
    return requirePath ? parsed.pathname.length > 1 : true;
  } catch {
    return false;
  }
}

// The first token that isn't a `--flag` and isn't a value belonging to one, or undefined
// if every token is a flag/its value.
function extractCommand(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      if (VALUE_FLAGS.includes(a)) {
        i++; // skip this flag's separate-token value
      }
      continue;
    }
    return a;
  }
  return undefined;
}

function main() {
  const args = process.argv.slice(2);
  const command = extractCommand(args) ?? 'install';
  let apiBaseUrl, repoRawBaseUrl;
  if (command === 'install') {
    apiBaseUrl = parseApiBaseUrlArg(args);
    repoRawBaseUrl = parseRepoUrlArg(args);
    // Both flags are required on EVERY install/reinstall, with no fallback to a
    // previously stored config.json value and no hardcoded default anywhere in source.
    if (!apiBaseUrl || !repoRawBaseUrl) {
      console.error(
        'Missing required --api-base-url <url> and/or --repo-raw-base-url <url>.');
      console.error(
        'Usage: npx <package> install --api-base-url <url> --repo-raw-base-url <url>');
      process.exit(1);
    }
    if (!isPlausibleUrl(apiBaseUrl, false) || !isPlausibleUrl(repoRawBaseUrl)) {
      console.error(
        '--api-base-url and --repo-raw-base-url must be valid http(s) URLs.');
      process.exit(1);
    }
  }
  run(command, apiBaseUrl, repoRawBaseUrl);
}

// Runs when executed directly (require.main === module) or from the loader's stdin run: a
// `node -` program has no main module, so it's recognized by that absent main plus the
// TUP_MODE we set — requiring absence rather than just checking TUP_MODE keeps a stray
// ambient env var from turning a plain `require('./updater.js')` (e.g. in a test) into an
// unintended lifecycle action.
if (require.main === module) {
  main();
} else if (!require.main && process.env.TUP_MODE === 'converge') {
  converge().catch(err => {
    logError('main', err);
  });
}

module.exports = {
  install,
  uninstall,
  run,
  readSettings,
  removeOwnHooks,
  patchSettings,
  hooksAreCurrent,
  installStatusLine,
  uninstallStatusLine,
  parseApiBaseUrlArg,
  parseRepoUrlArg,
  extractCommand,
  isPlausibleUrl,
  loadConfig,
  saveConfig,
  main,
  converge,
  semverGt,
  isValidPayload,
  acquireUpdateLock,
  releaseUpdateLock,
  isProcessAlive,
  rawUrl,
  fetchWithTimeout,
  localPluginFiles,
  pluginFileDest,
  HOOK_DEST,
  STATUSLINE_DEST,
  UPDATE_LOCK_FILE,
  HOOK_REF,
};
