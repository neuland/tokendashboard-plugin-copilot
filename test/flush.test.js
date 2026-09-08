'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { inSandboxAsync, stubFetch, queueDir, deadLetterDir } = require('./helpers.js');

const ok = { ok: true, status: 200 };
const TEST_API_BASE_URL = 'https://example.test';
const TEST_INGEST_URL = TEST_API_BASE_URL + '/api/usage/ingest/copilot';

test('flush does nothing and makes no request on an empty queue', async () => {
  await inSandboxAsync(async hook => {
    // given — an empty queue
    const fetch = stubFetch(() => ok);

    // when
    try {
      await hook.flush();
    } finally {
      fetch.restore();
    }

    // then
    assert.equal(fetch.calls.length, 0);
  });
});

test('flush refuses to send and keeps the queue when no api base url is configured', async () => {
  await inSandboxAsync(async hook => {
    // given — a queued entry but no api base url in config (pre-requirement install, or
    // a corrupt config.json)
    hook.writeEntry({ session_id: 's1', model: 'm', usage: { input_tokens: 1 } });
    const fetch = stubFetch(() => {
      throw new Error('should not be called — no api base url configured');
    });

    // when
    try {
      await hook.flush();
    } finally {
      fetch.restore();
    }

    // then — no request attempted, entry stays queued
    assert.equal(fetch.calls.length, 0);
    assert.equal(hook.getQueueFiles().length, 1);
  });
});

test('flush posts all entries and clears the queue on HTTP 200', async () => {
  await inSandboxAsync(async hook => {
    // given — two queued entries and a known plugin version
    hook.saveConfig({ currentVersion: '0.6.0', apiBaseUrl: TEST_API_BASE_URL });
    hook.writeEntry({ session_id: 's1', model: 'gpt-5.4-mini', usage: { input_tokens: 1 } });
    hook.writeEntry({ session_id: 's1', model: 'gpt-5.4', usage: { input_tokens: 2 } });
    const fetch = stubFetch(() => ok);

    // when
    try {
      await hook.flush();
    } finally {
      fetch.restore();
    }

    // then — one POST to the ingest path under the configured api base url, carrying
    // user_id + plugin_version + both entries, queue emptied afterwards
    assert.equal(fetch.calls.length, 1);
    assert.equal(fetch.calls[0].url, TEST_INGEST_URL);
    const body = JSON.parse(fetch.calls[0].options.body);
    assert.match(body.user_id, /^[0-9a-f-]{36}$/);
    assert.equal(body.plugin_version, '0.6.0');
    assert.equal(body.prompts.length, 2);
    assert.equal(hook.getQueueFiles().length, 0);
  });
});

test("flush sends plugin_version 'unknown' when no version is configured", async () => {
  await inSandboxAsync(async hook => {
    // given — a queued entry and an api base url but no currentVersion (pre-versioned / fresh install)
    hook.saveConfig({ apiBaseUrl: TEST_API_BASE_URL });
    hook.writeEntry({ session_id: 's1', model: 'm', usage: {} });
    const fetch = stubFetch(() => ok);

    // when
    try {
      await hook.flush();
    } finally {
      fetch.restore();
    }

    // then — the payload falls back to 'unknown' rather than null
    const body = JSON.parse(fetch.calls[0].options.body);
    assert.equal(body.plugin_version, 'unknown');
  });
});

test('flush keeps entries queued on a network error', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given — a queued entry and a failing network
    hook.saveConfig({ apiBaseUrl: TEST_API_BASE_URL });
    hook.writeEntry({ session_id: 's1', model: 'm', usage: {} });
    const fetch = stubFetch(() => {
      throw new Error('ECONNREFUSED');
    });

    // when
    try {
      await hook.flush();
    } finally {
      fetch.restore();
    }

    // then — entry remains and the lock was released
    assert.equal(hook.getQueueFiles().length, 1);
    assert.equal(fs.existsSync(path.join(queueDir(home), '.lock')), false);
  });
});

test('flush keeps entries queued on a non-2xx response', async () => {
  await inSandboxAsync(async hook => {
    // given — a queued entry and a server error
    hook.saveConfig({ apiBaseUrl: TEST_API_BASE_URL });
    hook.writeEntry({ session_id: 's1', model: 'm', usage: {} });
    const fetch = stubFetch(() => ({ ok: false, status: 500 }));

    // when
    try {
      await hook.flush();
    } finally {
      fetch.restore();
    }

    // then
    assert.equal(hook.getQueueFiles().length, 1);
  });
});

test('flush skips an unparseable queue file but still posts the valid ones', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given — one good entry plus a corrupt queue file
    hook.saveConfig({ apiBaseUrl: TEST_API_BASE_URL });
    hook.writeEntry({ session_id: 's1', model: 'm', usage: { input_tokens: 1 } });
    fs.writeFileSync(path.join(queueDir(home), '999-1-0.json'), 'not json {');
    const fetch = stubFetch(() => ok);

    // when
    try {
      await hook.flush();
    } finally {
      fetch.restore();
    }

    // then — only the valid entry is sent; the whole snapshot (incl. the bad file) is cleared
    assert.equal(fetch.calls.length, 1);
    assert.equal(JSON.parse(fetch.calls[0].options.body).prompts.length, 1);
    assert.equal(hook.getQueueFiles().length, 0);
  });
});

test('flush makes no request when every queued file is unparseable', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given — a queue containing only corrupt files
    hook.saveConfig({ apiBaseUrl: TEST_API_BASE_URL });
    fs.mkdirSync(queueDir(home), { recursive: true });
    fs.writeFileSync(path.join(queueDir(home), '999-1-0.json'), 'garbage');
    const fetch = stubFetch(() => ok);

    // when
    try {
      await hook.flush();
    } finally {
      fetch.restore();
    }

    // then — nothing parseable to send, so no request; the lock is released
    assert.equal(fetch.calls.length, 0);
    assert.equal(fs.existsSync(path.join(queueDir(home), '.lock')), false);
  });
});

test('flush sends entries in bounded batches and clears the queue', async () => {
  await inSandboxAsync(async hook => {
    // given — one more entry than fits in a single batch
    hook.saveConfig({ apiBaseUrl: TEST_API_BASE_URL });
    const n = hook.FLUSH_BATCH_SIZE + 1;
    for (let i = 0; i < n; i++) {
      hook.writeEntry({ session_id: 's1', model: 'm', usage: { input_tokens: i } });
    }
    const fetch = stubFetch(() => ok);

    // when
    try {
      await hook.flush();
    } finally {
      fetch.restore();
    }

    // then — two POSTs, neither exceeding the batch cap, all entries delivered
    assert.equal(fetch.calls.length, 2);
    const sizes = fetch.calls.map(c => JSON.parse(c.options.body).prompts.length);
    assert.ok(sizes.every(s => s <= hook.FLUSH_BATCH_SIZE));
    assert.equal(sizes.reduce((a, b) => a + b, 0), n);
    assert.equal(hook.getQueueFiles().length, 0);
  });
});

test('flush quarantines a batch to dead-letter on a permanent 4xx', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given — a queued entry and a server that rejects it as a bad request
    hook.saveConfig({ apiBaseUrl: TEST_API_BASE_URL });
    hook.writeEntry({ session_id: 's1', model: 'm', usage: { input_tokens: 1 } });
    const fetch = stubFetch(() => ({ ok: false, status: 400 }));

    // when
    try {
      await hook.flush();
    } finally {
      fetch.restore();
    }

    // then — posted once (no infinite retry), removed from the queue, kept in dead-letter
    assert.equal(fetch.calls.length, 1);
    assert.equal(hook.getQueueFiles().length, 0);
    assert.equal(fs.readdirSync(deadLetterDir(home)).length, 1);
  });
});

test('flush keeps entries queued on a 404 (endpoint briefly undeployed, retryable)', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given — a queued entry and the endpoint momentarily answering 404
    hook.saveConfig({ apiBaseUrl: TEST_API_BASE_URL });
    hook.writeEntry({ session_id: 's1', model: 'm', usage: { input_tokens: 1 } });
    const fetch = stubFetch(() => ({ ok: false, status: 404 }));

    // when
    try {
      await hook.flush();
    } finally {
      fetch.restore();
    }

    // then — treated as transient (a deploy blip), not a permanent rejection: the entry
    // stays queued for the next flush and nothing is quarantined
    assert.equal(hook.getQueueFiles().length, 1);
    assert.equal(fs.existsSync(deadLetterDir(home)), false);
  });
});

test('flush isolates a single poison entry and still delivers the rest of the batch', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given — eight entries, exactly one of which the server permanently rejects (400)
    hook.saveConfig({ apiBaseUrl: TEST_API_BASE_URL });
    const n = 8;
    for (let i = 0; i < n; i++) {
      hook.writeEntry({ session_id: 's1', model: 'm', usage: { input_tokens: i }, poison: i === 3 });
    }
    const fetch = stubFetch((url, options) => {
      const { prompts } = JSON.parse(options.body);
      return prompts.some(p => p.poison) ? { ok: false, status: 400 } : ok;
    });

    // when
    try {
      await hook.flush();
    } finally {
      fetch.restore();
    }

    // then — only the poison entry is quarantined; the other seven are delivered
    assert.equal(hook.getQueueFiles().length, 0);
    const dead = fs.readdirSync(deadLetterDir(home));
    assert.equal(dead.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(deadLetterDir(home), dead[0]), 'utf8')).poison, true);
  });
});

test('flush dead-letters every entry when the server rejects them all', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given — several entries, all permanently rejected (422)
    hook.saveConfig({ apiBaseUrl: TEST_API_BASE_URL });
    const n = 4;
    for (let i = 0; i < n; i++) {
      hook.writeEntry({ session_id: 's1', model: 'm', usage: { input_tokens: i } });
    }
    const fetch = stubFetch(() => ({ ok: false, status: 422 }));

    // when
    try {
      await hook.flush();
    } finally {
      fetch.restore();
    }

    // then — bisection ends with each lone entry quarantined; queue cleared
    assert.equal(hook.getQueueFiles().length, 0);
    assert.equal(fs.readdirSync(deadLetterDir(home)).length, n);
  });
});

test('flush leaves unsent entries queued when a transient error interrupts bisection', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given — four entries; the full-batch POST is rejected (400), then the first
    // bisected half hits a transient network error before any entry is delivered
    hook.saveConfig({ apiBaseUrl: TEST_API_BASE_URL });
    const n = 4;
    for (let i = 0; i < n; i++) {
      hook.writeEntry({ session_id: 's1', model: 'm', usage: { input_tokens: i } });
    }
    const fetch = stubFetch((url, options, callIndex) => {
      if (callIndex === 0) {
        return { ok: false, status: 400 }; // whole batch rejected → bisect
      }
      throw new Error('ECONNREFUSED'); // first half: network drops mid-flush
    });

    // when
    try {
      await hook.flush();
    } finally {
      fetch.restore();
    }

    // then — nothing delivered, nothing quarantined: all entries survive for a retry
    assert.equal(hook.getQueueFiles().length, n);
    assert.equal(fs.existsSync(deadLetterDir(home)), false);
  });
});

test('flush keeps entries queued on a 429 (throttled, retryable)', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given — a queued entry and a throttling response
    hook.saveConfig({ apiBaseUrl: TEST_API_BASE_URL });
    hook.writeEntry({ session_id: 's1', model: 'm', usage: { input_tokens: 1 } });
    const fetch = stubFetch(() => ({ ok: false, status: 429 }));

    // when
    try {
      await hook.flush();
    } finally {
      fetch.restore();
    }

    // then — left in the queue for the next flush, nothing quarantined
    assert.equal(hook.getQueueFiles().length, 1);
    assert.equal(fs.existsSync(deadLetterDir(home)), false);
  });
});

// A response that looks like HTTP 200 but carries an HTML body (text/html) is a
// captive-portal / proxy login page, not a genuine ingest — the entry must survive.
const htmlHeaders = { get: h => (h.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null) };

test('flush keeps entries queued on a captive-portal 200 HTML response', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given — a queued entry and a proxy answering 200 with an HTML login page
    hook.saveConfig({ apiBaseUrl: TEST_API_BASE_URL });
    hook.writeEntry({ session_id: 's1', model: 'm', usage: { input_tokens: 1 } });
    const fetch = stubFetch(() => ({ ok: true, status: 200, headers: htmlHeaders }));

    // when
    try {
      await hook.flush();
    } finally {
      fetch.restore();
    }

    // then — not treated as delivered: entry stays queued, nothing dead-lettered
    assert.equal(hook.getQueueFiles().length, 1);
    assert.equal(fs.existsSync(deadLetterDir(home)), false);
  });
});

test('flush keeps entries queued when the POST was redirected (portal)', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given — a queued entry and a response fetch followed a redirect to reach
    hook.saveConfig({ apiBaseUrl: TEST_API_BASE_URL });
    hook.writeEntry({ session_id: 's1', model: 'm', usage: { input_tokens: 1 } });
    const fetch = stubFetch(() => ({ ok: true, status: 200, redirected: true }));

    // when
    try {
      await hook.flush();
    } finally {
      fetch.restore();
    }

    // then — a followed redirect is not a genuine ingest; entry stays queued
    assert.equal(hook.getQueueFiles().length, 1);
    assert.equal(fs.existsSync(deadLetterDir(home)), false);
  });
});

test('flush keeps entries queued on a 407 proxy-auth response (retryable)', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given — a queued entry and an off-VPN proxy demanding authentication
    hook.saveConfig({ apiBaseUrl: TEST_API_BASE_URL });
    hook.writeEntry({ session_id: 's1', model: 'm', usage: { input_tokens: 1 } });
    const fetch = stubFetch(() => ({ ok: false, status: 407 }));

    // when
    try {
      await hook.flush();
    } finally {
      fetch.restore();
    }

    // then — proxy gateway error is transient: kept in queue, not dead-lettered
    assert.equal(hook.getQueueFiles().length, 1);
    assert.equal(fs.existsSync(deadLetterDir(home)), false);
  });
});

test('flush delivers and clears the queue on a JSON 200 (genuine ingest)', async () => {
  await inSandboxAsync(async hook => {
    // given — a queued entry and the real endpoint answering JSON 200
    hook.saveConfig({ apiBaseUrl: TEST_API_BASE_URL });
    hook.writeEntry({ session_id: 's1', model: 'm', usage: { input_tokens: 1 } });
    const jsonHeaders = { get: h => (h.toLowerCase() === 'content-type' ? 'application/json' : null) };
    const fetch = stubFetch(() => ({ ok: true, status: 200, headers: jsonHeaders }));

    // when
    try {
      await hook.flush();
    } finally {
      fetch.restore();
    }

    // then — a genuine success clears the queue
    assert.equal(fetch.calls.length, 1);
    assert.equal(hook.getQueueFiles().length, 0);
  });
});

test('flush makes no request when the lock is held by a live process', async () => {
  await inSandboxAsync(async (hook, home) => {
    // given — a queued entry and a lock held by a live process (the test runner)
    hook.saveConfig({ apiBaseUrl: TEST_API_BASE_URL });
    hook.writeEntry({ session_id: 's1', model: 'm', usage: {} });
    fs.writeFileSync(path.join(queueDir(home), '.lock'), String(process.pid));
    const fetch = stubFetch(() => ok);

    // when
    try {
      await hook.flush();
    } finally {
      fetch.restore();
    }

    // then — no request, entry stays queued, foreign lock untouched
    assert.equal(fetch.calls.length, 0);
    assert.equal(hook.getQueueFiles().length, 1);
    assert.equal(fs.readFileSync(path.join(queueDir(home), '.lock'), 'utf8'), String(process.pid));
  });
});
