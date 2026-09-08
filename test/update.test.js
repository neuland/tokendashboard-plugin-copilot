'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { inSandboxAsync, stubFetch } = require('./helpers.js');

// updateFromRemote is the loader half of the update mechanism: it fetches updater.js
// fresh from the configured repoRawBaseUrl and hands the source text to runFn (production:
// runUpdaterSource, which pipes it into a detached `node -`). All the actual
// version-comparison / file-write / lock logic now lives in updater.js's converge(),
// exercised separately in converge.test.js — this file only covers the fetch-and-hand-off.

const RAW_BASE = 'https://raw.githubusercontent.com/foo/bar/main';

test('updateFromRemote makes no request when no currentVersion is configured', async () => {
  await inSandboxAsync(async hook => {
    // given — no config written (no currentVersion)
    const fetch = stubFetch(() => {
      throw new Error('should not be called');
    });
    const runFn = () => {
      throw new Error('should not run — nothing was fetched');
    };

    // when
    try {
      await hook.updateFromRemote(runFn);
    } finally {
      fetch.restore();
    }

    // then
    assert.equal(fetch.calls.length, 0);
  });
});

test('updateFromRemote is a no-op when config.repoRawBaseUrl is absent — no fallback default', async () => {
  await inSandboxAsync(async hook => {
    // given — an installed version with no repoRawBaseUrl configured (an install
    // predating the requirement, or a corrupt config)
    hook.saveConfig({ currentVersion: '0.2.0' });
    const fetch = stubFetch(() => {
      throw new Error('should not be called — no update source configured');
    });
    let ran = false;

    // when
    try {
      await hook.updateFromRemote(() => {
        ran = true;
      });
    } finally {
      fetch.restore();
    }

    // then
    assert.equal(fetch.calls.length, 0);
    assert.equal(ran, false);
  });
});

test('updateFromRemote does not run when the fetch fails', async () => {
  await inSandboxAsync(async hook => {
    // given
    hook.saveConfig({ currentVersion: '0.2.0', repoRawBaseUrl: RAW_BASE });
    const fetch = stubFetch(() => {
      throw new Error('ECONNREFUSED');
    });
    let ran = false;

    // when
    try {
      await hook.updateFromRemote(() => {
        ran = true;
      });
    } finally {
      fetch.restore();
    }

    // then
    assert.equal(fetch.calls.length, 1);
    assert.equal(ran, false);
  });
});

test('updateFromRemote does not run on a non-ok response', async () => {
  await inSandboxAsync(async hook => {
    // given
    hook.saveConfig({ currentVersion: '0.2.0', repoRawBaseUrl: RAW_BASE });
    const fetch = stubFetch(() => ({ ok: false, status: 500, text: async () => 'oops' }));
    let ran = false;

    // when
    try {
      await hook.updateFromRemote(() => {
        ran = true;
      });
    } finally {
      fetch.restore();
    }

    // then
    assert.equal(ran, false);
  });
});

test('updateFromRemote does not run when the fetch was redirected (captive portal)', async () => {
  await inSandboxAsync(async hook => {
    // given — even a body that looks like source must not be trusted after a redirect
    hook.saveConfig({ currentVersion: '0.2.0', repoRawBaseUrl: RAW_BASE });
    const fetch = stubFetch(() => ({
      ok: true, status: 200, redirected: true, text: async () => 'module.exports = {};\n',
    }));
    let ran = false;

    // when
    try {
      await hook.updateFromRemote(() => {
        ran = true;
      });
    } finally {
      fetch.restore();
    }

    // then
    assert.equal(ran, false);
  });
});

test('updateFromRemote does not run on an HTML error page', async () => {
  await inSandboxAsync(async hook => {
    // given
    hook.saveConfig({ currentVersion: '0.2.0', repoRawBaseUrl: RAW_BASE });
    const fetch = stubFetch(() => ({
      ok: true, status: 200, text: async () => '<!DOCTYPE html>\n<html>error</html>',
    }));
    let ran = false;

    // when
    try {
      await hook.updateFromRemote(() => {
        ran = true;
      });
    } finally {
      fetch.restore();
    }

    // then
    assert.equal(ran, false);
  });
});

test('updateFromRemote hands the fetched source to runFn on success', async () => {
  await inSandboxAsync(async hook => {
    // given
    hook.saveConfig({ currentVersion: '0.2.0', repoRawBaseUrl: RAW_BASE });
    const source = '// updater source\nmodule.exports = {};\n';
    const fetch = stubFetch(url => {
      assert.equal(url, `${RAW_BASE}/updater.js`);
      return { ok: true, status: 200, text: async () => source };
    });
    let received;

    // when
    try {
      await hook.updateFromRemote(s => {
        received = s;
      });
    } finally {
      fetch.restore();
    }

    // then
    assert.equal(received, source);
  });
});

test('updateFromRemote strips a trailing slash from a configured repoRawBaseUrl (no double slash)', async () => {
  await inSandboxAsync(async hook => {
    // given
    hook.saveConfig({ currentVersion: '0.2.0', repoRawBaseUrl: `${RAW_BASE}/` });
    const fetch = stubFetch(() => ({ ok: true, status: 200, text: async () => 'module.exports = {};\n' }));

    // when
    try {
      await hook.updateFromRemote(() => {});
    } finally {
      fetch.restore();
    }

    // then
    assert.equal(fetch.calls[0].url, `${RAW_BASE}/updater.js`);
  });
});

test('rawUrl joins a base and file without producing a double slash', () => {
  const inSandbox = require('./helpers.js').inSandbox;
  inSandbox(hook => {
    assert.equal(hook.rawUrl('https://example.test/main', 'updater.js'), 'https://example.test/main/updater.js');
    assert.equal(hook.rawUrl('https://example.test/main/', 'updater.js'), 'https://example.test/main/updater.js');
  });
});
