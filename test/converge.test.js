'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const { inCliSandboxAsync, stubFetch, hookDest, configPath, settingsPath } = require('./helpers.js');

// converge() is the fetched-and-run half of the update mechanism (see updater.js's own
// comment): hook.js's loader pipes updater.js's source into a fresh `node -` process with
// TUP_MODE=converge, which runs this function. It downloads pluginFiles (hook.js today),
// self-heals settings.json, and records lastUpdateCheck.

function routes({ pkg, hook }) {
  return url => {
    if (url.endsWith('package.json')) {
      return pkg;
    }
    if (url.endsWith('hook.js')) {
      return hook;
    }
    throw new Error(`unexpected url: ${url}`);
  };
}

const pkgVersion = (v, extra = {}) => ({ ok: true, status: 200, json: async () => ({ version: v, ...extra }) });
const hookPayload = text => ({ ok: true, status: 200, text: async () => text });

const DEAD_PID = 2147483647; // out of range — guaranteed no such process

const RAW_BASE = 'https://raw.githubusercontent.com/foo/bar/main';

const readConfig = home => JSON.parse(fs.readFileSync(configPath(home), 'utf8'));
const readSettings = home => JSON.parse(fs.readFileSync(settingsPath(home), 'utf8'));

test('converge makes no request when no currentVersion is configured', async () => {
  await inCliSandboxAsync(async cli => {
    // given — no config written
    const fetch = stubFetch(() => {
      throw new Error('should not be called');
    });

    // when
    try {
      await cli.converge();
    } finally {
      fetch.restore();
    }

    // then
    assert.equal(fetch.calls.length, 0);
  });
});

test('converge is a no-op when config.repoRawBaseUrl is absent — no fallback default', async () => {
  await inCliSandboxAsync(async (cli, home) => {
    // given — an installed version with no repoRawBaseUrl configured
    cli.saveConfig({ currentVersion: '0.2.0' });
    const fetch = stubFetch(() => {
      throw new Error('should not be called — no update source configured');
    });

    // when
    try {
      await cli.converge();
    } finally {
      fetch.restore();
    }

    // then
    assert.equal(fetch.calls.length, 0);
    assert.equal(readConfig(home).lastUpdateCheck, undefined);
  });
});

test('converge leaves config untouched when the version probe fails', async () => {
  await inCliSandboxAsync(async (cli, home) => {
    // given
    cli.saveConfig({ currentVersion: '0.2.0', repoRawBaseUrl: RAW_BASE });
    const fetch = stubFetch(() => {
      throw new Error('ECONNREFUSED');
    });

    // when
    try {
      await cli.converge();
    } finally {
      fetch.restore();
    }

    // then — only the probe was attempted, no lastUpdateCheck recorded
    assert.equal(fetch.calls.length, 1);
    assert.equal(readConfig(home).lastUpdateCheck, undefined);
    assert.equal(readConfig(home).currentVersion, '0.2.0');
  });
});

test('converge records the check but does not fetch pluginFiles when remote is not newer', async () => {
  await inCliSandboxAsync(async (cli, home) => {
    // given — remote version equals current
    cli.saveConfig({ currentVersion: '0.2.0', repoRawBaseUrl: RAW_BASE });
    const fetch = stubFetch(routes({ pkg: pkgVersion('0.2.0') }));

    // when
    try {
      await cli.converge();
    } finally {
      fetch.restore();
    }

    // then — probe recorded, hook.js never fetched
    assert.equal(fetch.calls.length, 1);
    assert.ok(readConfig(home).lastUpdateCheck);
    assert.equal(readConfig(home).currentVersion, '0.2.0');
    assert.equal(fs.existsSync(hookDest(home)), false);
  });
});

test('converge refuses to apply an HTML error page', async () => {
  await inCliSandboxAsync(async (cli, home) => {
    // given
    cli.saveConfig({ currentVersion: '0.2.0', repoRawBaseUrl: RAW_BASE });
    const fetch = stubFetch(routes({
      pkg: pkgVersion('0.3.0'),
      hook: hookPayload('<!DOCTYPE html>\n<html>error</html>'),
    }));

    // when
    try {
      await cli.converge();
    } finally {
      fetch.restore();
    }

    // then — version left unchanged, nothing written
    assert.equal(fs.existsSync(hookDest(home)), false);
    assert.equal(readConfig(home).currentVersion, '0.2.0');
  });
});

test('converge refuses to apply an unparseable JS payload', async () => {
  await inCliSandboxAsync(async (cli, home) => {
    // given — a 200 body that is neither HTML nor valid JavaScript (e.g. a
    // captive-portal <html> page that happens not to start with "<!")
    cli.saveConfig({ currentVersion: '0.2.0', repoRawBaseUrl: RAW_BASE });
    const fetch = stubFetch(routes({
      pkg: pkgVersion('0.3.0'),
      hook: hookPayload('<html><body>Sign in to continue</body></html>'),
    }));

    // when
    try {
      await cli.converge();
    } finally {
      fetch.restore();
    }

    // then
    assert.equal(fs.existsSync(hookDest(home)), false);
    assert.equal(readConfig(home).currentVersion, '0.2.0');
  });
});

test('converge refuses a hook payload delivered via a followed redirect', async () => {
  await inCliSandboxAsync(async (cli, home) => {
    // given — even a body that looks like valid source must not be trusted after a redirect
    cli.saveConfig({ currentVersion: '0.2.0', repoRawBaseUrl: RAW_BASE });
    const fetch = stubFetch(routes({
      pkg: pkgVersion('0.3.0'),
      hook: { ok: true, status: 200, redirected: true, text: async () => 'module.exports = {};\n' },
    }));

    // when
    try {
      await cli.converge();
    } finally {
      fetch.restore();
    }

    // then
    assert.equal(fs.existsSync(hookDest(home)), false);
    assert.equal(readConfig(home).currentVersion, '0.2.0');
  });
});

test('converge skips entirely when the update lock is held by a live process', async () => {
  await inCliSandboxAsync(async cli => {
    // given — a held update lock owned by a live process (the test runner itself)
    cli.saveConfig({ currentVersion: '0.2.0', repoRawBaseUrl: RAW_BASE });
    fs.mkdirSync(require('path').dirname(cli.UPDATE_LOCK_FILE), { recursive: true });
    fs.writeFileSync(cli.UPDATE_LOCK_FILE, String(process.pid));
    const fetch = stubFetch(() => {
      throw new Error('should not be called while another update holds the lock');
    });

    // when
    try {
      await cli.converge();
    } finally {
      fetch.restore();
    }

    // then — no request made, live lock intact
    assert.equal(fetch.calls.length, 0);
    assert.equal(fs.readFileSync(cli.UPDATE_LOCK_FILE, 'utf8'), String(process.pid));
  });
});

test('converge steals a stale update lock and applies the update', async () => {
  await inCliSandboxAsync(async (cli, home) => {
    // given — a stale update lock from a crashed updater (dead pid) and a newer remote
    cli.saveConfig({ currentVersion: '0.2.0', repoRawBaseUrl: RAW_BASE });
    fs.mkdirSync(require('path').dirname(cli.UPDATE_LOCK_FILE), { recursive: true });
    fs.writeFileSync(cli.UPDATE_LOCK_FILE, String(DEAD_PID));
    const newContent = '// updated hook\nmodule.exports = {};\n';
    const fetch = stubFetch(routes({ pkg: pkgVersion('0.3.0'), hook: hookPayload(newContent) }));

    // when
    try {
      await cli.converge();
    } finally {
      fetch.restore();
    }

    // then — stale lock stolen, update applied, lock released afterwards
    assert.equal(fs.readFileSync(hookDest(home), 'utf8'), newContent);
    assert.equal(readConfig(home).currentVersion, '0.3.0');
    assert.equal(fs.existsSync(cli.UPDATE_LOCK_FILE), false);
  });
});

test('converge fetches from the configured repoRawBaseUrl and strips a trailing slash', async () => {
  await inCliSandboxAsync(async (cli, home) => {
    // given
    cli.saveConfig({ currentVersion: '0.2.0', repoRawBaseUrl: `${RAW_BASE}/` });
    const newContent = '// updated hook\nmodule.exports = {};\n';
    const fetch = stubFetch(routes({ pkg: pkgVersion('0.3.0'), hook: hookPayload(newContent) }));

    // when
    try {
      await cli.converge();
    } finally {
      fetch.restore();
    }

    // then — no double slash in the fetched URLs
    assert.deepEqual(fetch.calls.map(c => c.url), [`${RAW_BASE}/package.json`, `${RAW_BASE}/hook.js`]);
    assert.equal(fs.readFileSync(hookDest(home), 'utf8'), newContent);
  });
});

test('converge atomically writes the new hook and bumps the version, leaving no .tmp', async () => {
  await inCliSandboxAsync(async (cli, home) => {
    // given
    cli.saveConfig({ currentVersion: '0.2.0', repoRawBaseUrl: RAW_BASE });
    const newContent = '// updated hook\nmodule.exports = {};\n';
    const fetch = stubFetch(routes({ pkg: pkgVersion('0.3.0'), hook: hookPayload(newContent) }));

    // when
    try {
      await cli.converge();
    } finally {
      fetch.restore();
    }

    // then
    assert.equal(fs.readFileSync(hookDest(home), 'utf8'), newContent);
    assert.equal(readConfig(home).currentVersion, '0.3.0');
    const dir = require('path').dirname(hookDest(home));
    assert.ok(!fs.readdirSync(dir).some(f => f.endsWith('.tmp')));
  });
});

test('converge downloads every file in a remote pluginFiles manifest', async () => {
  await inCliSandboxAsync(async (cli, home) => {
    // given — a remote package.json listing two payload files
    cli.saveConfig({ currentVersion: '0.2.0', repoRawBaseUrl: RAW_BASE });
    const hookContent = '// hook v2\nmodule.exports = {};\n';
    const extraContent = '// extra payload file\nmodule.exports = {};\n';
    const fetch = stubFetch(url => {
      if (url.endsWith('package.json')) {
        return pkgVersion('0.3.0', { pluginFiles: ['hook.js', 'extra.js'] });
      }
      if (url.endsWith('hook.js')) {
        return hookPayload(hookContent);
      }
      if (url.endsWith('extra.js')) {
        return hookPayload(extraContent);
      }
      throw new Error(`unexpected url: ${url}`);
    });

    // when
    try {
      await cli.converge();
    } finally {
      fetch.restore();
    }

    // then
    const dir = require('path').dirname(hookDest(home));
    assert.equal(fs.readFileSync(hookDest(home), 'utf8'), hookContent);
    assert.equal(fs.readFileSync(require('path').join(dir, 'extra.js'), 'utf8'), extraContent);
    assert.equal(readConfig(home).currentVersion, '0.3.0');
  });
});

test('converge self-heals settings.json when our hook entries have drifted', async () => {
  await inCliSandboxAsync(async (cli, home) => {
    // given — installed, but settings.json lost our hook entries entirely
    cli.install('https://example.test/ingest', RAW_BASE);
    const settings = readSettings(home);
    delete settings.hooks;
    fs.writeFileSync(settingsPath(home), JSON.stringify(settings));
    const fetch = stubFetch(routes({ pkg: pkgVersion(readConfig(home).currentVersion) }));

    // when
    try {
      await cli.converge();
    } finally {
      fetch.restore();
    }

    // then — restored
    const after = readSettings(home);
    assert.equal(after.hooks.sessionStart.length, 1);
    assert.equal(after.hooks.sessionEnd.length, 1);
  });
});

test('converge self-heals a missing statusLine entry', async () => {
  await inCliSandboxAsync(async (cli, home) => {
    // given — installed, but statusLine got dropped from settings.json
    cli.install('https://example.test/ingest', RAW_BASE);
    const settings = readSettings(home);
    delete settings.statusLine;
    fs.writeFileSync(settingsPath(home), JSON.stringify(settings));
    const fetch = stubFetch(routes({ pkg: pkgVersion(readConfig(home).currentVersion) }));

    // when
    try {
      await cli.converge();
    } finally {
      fetch.restore();
    }

    // then
    assert.ok(readSettings(home).statusLine?.command?.includes('statusline.js'));
  });
});

test('converge leaves a foreign statusLine untouched', async () => {
  await inCliSandboxAsync(async (cli, home) => {
    // given — installed with a foreign statusLine already present before install
    fs.mkdirSync(require('path').dirname(settingsPath(home)), { recursive: true });
    fs.writeFileSync(settingsPath(home), JSON.stringify({
      statusLine: { type: 'command', command: 'my-other-tool.sh' },
    }));
    cli.install('https://example.test/ingest', RAW_BASE);
    const fetch = stubFetch(routes({ pkg: pkgVersion(readConfig(home).currentVersion) }));

    // when
    try {
      await cli.converge();
    } finally {
      fetch.restore();
    }

    // then
    assert.equal(readSettings(home).statusLine.command, 'my-other-tool.sh');
  });
});
