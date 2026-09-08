#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');

// Deliberately not require('./hook.js') or require('./updater.js') — both are auto-updated
// independently, so depending on their internals risks breaking this script. Self-contained.
const PLUGIN_DIR = path.join(os.homedir(), '.copilot', 'tokendashboard-plugin');
const QUEUE_DIR = path.join(PLUGIN_DIR, 'queue');
const LOG_PATH = path.join(PLUGIN_DIR, 'error.log');
const EXCEPTIONS_PATH = path.join(PLUGIN_DIR, 'exceptions.txt');
const CONFIG_PATH = path.join(PLUGIN_DIR, 'config.json');

// Backlog older than this is no longer "waiting for the next sessionEnd flush" — it
// means the endpoint has been unreachable across multiple sessions.
const STALE_QUEUE_MS = 24 * 60 * 60 * 1000;
// A logged error inside this window is still relevant to today's session.
const ERROR_RECENCY_MS = 15 * 60 * 1000;

// currentVersion is stamped into config.json by the updater on install/update — read
// directly rather than depending on hook.js/updater.js internals, same self-containment
// rule as the rest of this file.
function readPluginVersion() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).currentVersion ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

// --- Hook health (does capture/send actually work) ---

function getQueueStatus(queueDir, now) {
  if (!fs.existsSync(queueDir)) {
    return { count: 0, oldestAgeMs: 0 };
  }
  const files = fs.readdirSync(queueDir).filter(f => f.endsWith('.json') && !f.startsWith('.'));
  if (files.length === 0) {
    return { count: 0, oldestAgeMs: 0 };
  }
  let oldest = now;
  for (const f of files) {
    const n = parseInt(f, 10);
    if (!Number.isNaN(n) && n < oldest) {
      oldest = n;
    }
  }
  return { count: files.length, oldestAgeMs: now - oldest };
}

// error.log is only ever appended to by logError(), so its mtime is the last error
// time — no need to parse content.
function hasRecentError(logPath, now, thresholdMs) {
  if (!fs.existsSync(logPath)) {
    return false;
  }
  try {
    return (now - fs.statSync(logPath).mtimeMs) < thresholdMs;
  } catch {
    return false;
  }
}

// exceptions.txt holds conditions that should never happen (see hook.js's
// logException) — unlike error.log, presence alone (no time window, no queue-state
// check) means "unresolved": it only goes away when a human reads it, fixes the
// cause, and clears it.
function hasException(exceptionsPath) {
  try {
    return fs.statSync(exceptionsPath).size > 0;
  } catch {
    return false;
  }
}

// --- Model / context window ---

function formatModelName(displayName, id) {
  if (typeof displayName === 'string' && displayName) {
    return displayName;
  }
  if (typeof id === 'string' && id) {
    return id;
  }
  return 'Unknown model';
}

// Copilot sends a 0-100 percentage; guard against missing/non-numeric.
function normalizeUsedPct(pct) {
  const n = Number(pct);
  if (!Number.isFinite(n)) {
    return 0;
  }
  return Math.min(100, Math.max(0, Math.round(n)));
}

// --- Formatting ---

function formatProgressBar(pct) {
  const filled = Math.round(pct / 10);
  return `${'▓'.repeat(filled)}${'░'.repeat(10 - filled)}`;
}

function formatPct(pct) {
  const color = pct >= 80 ? '\x1b[31m' : pct >= 40 ? '\x1b[95m' : ''; // red/bright magenta/none
  const reset = color ? '\x1b[0m' : '';
  const text = pct >= 80 ? `${pct}% COMPACT!` : `${pct}%`;
  return `${color}${text}${reset}`;
}

// ANSI-colored ●
function dot(color) {
  const codes = { red: '\x1b[31m', none: '\x1b[0m', blue: '\x1b[34m' };
  return `${codes[color]}●\x1b[0m`;
}

function formatTokens(n) {
  if (n >= 1e6) {
    return `${(n / 1e6).toFixed(1)}M`;
  }
  if (n >= 1e3) {
    return `${(n / 1e3).toFixed(1)}k`;
  }
  return String(n);
}

function formatPrice(dollars) {
  return `$${dollars.toFixed(2)}`;
}

function formatAge(ms) {
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  if (days >= 1) {
    return `${days}d`;
  }
  const hours = Math.floor(ms / (60 * 60 * 1000));
  return `${Math.max(hours, 1)}h`;
}

function buildStatusLine({
  modelName, queue, recentError, exception, contextPct, version, inputTokens, outputTokens,
  priceDollars,
}) {
  let syncSegment;
  if (exception) {
    syncSegment = `${dot('red')} exception — see exceptions.txt`;
  } else if ((recentError && queue.count > 0) || queue.oldestAgeMs > STALE_QUEUE_MS) {
    const suffix = queue.count > 0 ? `${queue.count} queued, ${formatAge(queue.oldestAgeMs)}` : 'error sending';
    syncSegment = `${dot('red')} ${suffix}`;
  } else if (queue.count > 0) {
    syncSegment = `${dot('none')} ${queue.count} queued`;
  } else {
    syncSegment = `${dot('blue')} synced`;
  }

  const bar = formatProgressBar(contextPct);
  const pctDisplay = formatPct(contextPct);

  // Arrows follow the network RX/TX convention: ↑ = sent (input tokens, uploaded to the
  // API), ↓ = received (output tokens, downloaded from the API).
  const priceLine = `tokendashboard-plugin v${version} · `
    + `${formatTokens(inputTokens)} ↑ / ${formatTokens(outputTokens)} ↓ · `
    + `${formatPrice(priceDollars)}`;

  return `${modelName} · ${syncSegment} · context window: ${bar} ${pctDisplay} \n${priceLine}`;
}

// --- Main ---

// Reads the (experimental, sparsely documented) Copilot CLI statusLine stdin payload:
// model.{id,display_name}, context_window.{total_input_tokens,total_output_tokens,
// current_context_used_percentage}, cost.total_nano_aiu. Copilot reports this
// cumulatively per session and already reflects real billed cost, so — unlike Claude
// Code, which exposes neither a live total nor a price — there is no need to reconstruct
// totals from a transcript or maintain a hardcoded per-model price table here.
async function main() {
  let payload = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    payload += chunk;
  }
  let input = {};
  try {
    input = JSON.parse(payload);
  } catch {
    // No input — still render a line from local plugin state alone.
  }

  const now = Date.now();
  const queue = getQueueStatus(QUEUE_DIR, now);
  const recentError = hasRecentError(LOG_PATH, now, ERROR_RECENCY_MS);
  const exception = hasException(EXCEPTIONS_PATH);
  const modelName = formatModelName(input.model?.display_name, input.model?.id);
  const contextWindow = input.context_window ?? {};
  const contextPct = normalizeUsedPct(contextWindow.current_context_used_percentage);
  const inputTokens = Number(contextWindow.total_input_tokens) || 0;
  const outputTokens = Number(contextWindow.total_output_tokens) || 0;
  const priceDollars = (Number(input.cost?.total_nano_aiu) || 0) / 1_000_000_000;
  const version = readPluginVersion();

  process.stdout.write(buildStatusLine({
    modelName, queue, recentError, exception, contextPct, version, inputTokens, outputTokens,
    priceDollars,
  }));
}

if (require.main === module) {
  main().catch(() => {
    process.stdout.write('tokendashboard: error');
  });
}

module.exports = {
  getQueueStatus,
  hasRecentError,
  hasException,
  formatTokens,
  formatAge,
  formatModelName,
  normalizeUsedPct,
  formatProgressBar,
  formatPct,
  formatPrice,
  dot,
  buildStatusLine,
  readPluginVersion,
  STALE_QUEUE_MS,
  ERROR_RECENCY_MS,
};
