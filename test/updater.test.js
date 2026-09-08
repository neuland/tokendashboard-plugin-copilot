'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { inCliSandbox, withTempHome, settingsPath, hookDest, configPath } = require('./helpers.js');
const { version } = require('../package.json');

const UPDATER_PATH = require.resolve('../updater.js');
const statuslineDest = home => path.join(home, '.copilot', 'tokendashboard-plugin', 'statusline.js');

const EVENTS = ['sessionStart', 'sessionEnd'];

const readSettings = home => JSON.parse(fs.readFileSync(settingsPath(home), 'utf8'));

// Write a settings.json before install/uninstall runs.
function seedSettings(home, settings) {
  fs.mkdirSync(path.dirname(settingsPath(home)), { recursive: true });
  fs.writeFileSync(settingsPath(home), JSON.stringify(settings, null, 2));
}

test('install copies the hook, writes config, and registers both events', () => {
  inCliSandbox((cli, home) => {
    // given — a fresh sandbox

    // when
    cli.install();

    // then — hook file exists, config carries the current version, both events registered
    assert.equal(fs.existsSync(hookDest(home)), true);

    const config = JSON.parse(fs.readFileSync(configPath(home), 'utf8'));
    assert.equal(config.currentVersion, version);
    assert.ok(config.lastUpdateCheck);

    const settings = readSettings(home);
    for (const event of EVENTS) {
      assert.equal(settings.hooks[event].length, 1);
      const entry = settings.hooks[event][0];
      assert.equal(entry.type, 'command');
      // Every key references the hook via $HOME (not an absolute path, so the same
      // settings.json works under a different home e.g. a devcontainer).
      for (const key of ['bash', 'powershell', 'command']) {
        assert.ok(entry[key].includes('$HOME/.copilot/hooks/tokendashboard-plugin.js'),
          `${event}.${key} references the hook via $HOME`);
        assert.ok(!entry[key].includes(home),
          `${event}.${key} bakes in no absolute home path`);
      }
      // bash leads with `command ` so IntelliJ's leading-`node` rewrite can't fire;
      // powershell and the `command` fallback keep bare node (PowerShell has no
      // `command` builtin). All invoke Node by bare name, never an absolute path.
      assert.ok(entry.bash.startsWith('command node '), `${event}.bash leads with \`command node\``);
      assert.ok(entry.powershell.startsWith('node '), `${event}.powershell invokes bare node`);
      assert.ok(entry.command.startsWith('node '), `${event}.command invokes bare node`);
    }
  });
});

test('install is idempotent — repeated runs never duplicate own entries', () => {
  inCliSandbox((cli, home) => {
    // given / when — install three times
    cli.install();
    cli.install();
    cli.install();

    // then — still exactly one entry per event
    const settings = readSettings(home);
    for (const event of EVENTS) {
      assert.equal(settings.hooks[event].length, 1);
    }
  });
});

test('install preserves foreign hooks and unrelated settings', () => {
  inCliSandbox((cli, home) => {
    // given — a pre-existing foreign sessionStart hook and an unrelated setting
    seedSettings(home, {
      model: 'gpt-5.4-mini',
      hooks: { sessionStart: [{ type: 'command', command: 'echo foreign' }] },
    });

    // when
    cli.install();

    // then — foreign sessionStart entry kept alongside ours; model untouched
    const settings = readSettings(home);
    assert.equal(settings.model, 'gpt-5.4-mini');
    assert.equal(settings.hooks.sessionStart.length, 2);
    const commands = settings.hooks.sessionStart.map(h => h.command);
    assert.ok(commands.includes('echo foreign'));
    assert.ok(commands.some(c => c.includes('$HOME/.copilot/hooks/tokendashboard-plugin.js')));
  });
});

test('uninstall removes the hook file and our entries but keeps foreign hooks', () => {
  inCliSandbox((cli, home) => {
    // given — our hooks installed, plus a foreign sessionStart hook added afterwards
    cli.install();
    const settings = readSettings(home);
    settings.hooks.sessionStart.push({ type: 'command', command: 'echo foreign' });
    fs.writeFileSync(settingsPath(home), JSON.stringify(settings, null, 2));

    // when
    cli.uninstall();

    // then — hook file gone, foreign sessionStart survives, our other events removed entirely
    assert.equal(fs.existsSync(hookDest(home)), false);
    const after = readSettings(home);
    assert.equal(after.hooks.sessionStart.length, 1);
    assert.equal(after.hooks.sessionStart[0].command, 'echo foreign');
    assert.equal(after.hooks.sessionEnd, undefined);
  });
});

test('uninstall removes our entries stored in Copilot per-shell (bash/powershell) form', () => {
  inCliSandbox((cli, home) => {
    // given — settings where our hooks are persisted as Copilot stores them: a
    // `command`-typed entry carrying per-shell `bash`/`powershell` keys (no `command`
    // field), each pointing at the installed hook dest.
    const ownCmd = `"node" "${hookDest(home)}" --session-start`;
    seedSettings(home, {
      hooks: {
        sessionStart: [{ type: 'command', bash: ownCmd, powershell: ownCmd }],
        sessionEnd: [{
          type: 'command',
          bash: `"node" "${hookDest(home)}" --session-end`,
          powershell: `"node" "${hookDest(home)}" --session-end`,
        }],
      },
    });

    // when
    cli.uninstall();

    // then — our per-shell entries are recognized and removed, leaving no hooks
    const settings = readSettings(home);
    assert.equal(settings.hooks, undefined);
  });
});

test('install does not duplicate our entries already stored in per-shell form', () => {
  inCliSandbox((cli, home) => {
    // given — a prior install persisted by Copilot in per-shell form
    const ownStart = `"node" "${hookDest(home)}" --session-start`;
    seedSettings(home, {
      hooks: { sessionStart: [{ type: 'command', bash: ownStart, powershell: ownStart }] },
    });

    // when — re-running install
    cli.install();

    // then — the stale per-shell entry is replaced, not appended next to a new one
    const settings = readSettings(home);
    assert.equal(settings.hooks.sessionStart.length, 1);
  });
});

test('uninstall drops the empty hooks object when nothing else remains', () => {
  inCliSandbox((cli, home) => {
    // given — a clean install with no foreign hooks
    cli.install();

    // when
    cli.uninstall();

    // then — hooks key removed entirely
    const settings = readSettings(home);
    assert.equal(settings.hooks, undefined);
  });
});

test('run dispatches "install" to the installer', () => {
  inCliSandbox((cli, home) => {
    // given — a fresh sandbox

    // when
    cli.run('install');

    // then — the hook file was written
    assert.equal(fs.existsSync(hookDest(home)), true);
  });
});

test('run dispatches "uninstall" to the uninstaller', () => {
  inCliSandbox((cli, home) => {
    // given — an installed hook
    cli.install();

    // when
    cli.run('uninstall');

    // then — the hook file is gone
    assert.equal(fs.existsSync(hookDest(home)), false);
  });
});

test('run exits with an error on an unknown command', () => {
  inCliSandbox(cli => {
    // given — process.exit and console.error stubbed so the test survives
    const origExit = process.exit;
    const origErr = console.error;
    process.exit = code => {
      throw new Error(`exit:${code}`);
    };
    console.error = () => {};

    // when / then — an unknown command exits non-zero
    try {
      assert.throws(() => cli.run('frobnicate'), /exit:1/);
    } finally {
      process.exit = origExit;
      console.error = origErr;
    }
  });
});

test('install stores the configured api-base-url and repo-raw-base-url in config.json', () => {
  inCliSandbox((cli, home) => {
    // given — a fresh sandbox

    // when
    cli.install('https://example.test', 'https://raw.githubusercontent.com/foo/bar/main');

    // then
    const config = JSON.parse(fs.readFileSync(configPath(home), 'utf8'));
    assert.equal(config.apiBaseUrl, 'https://example.test');
    assert.equal(config.repoRawBaseUrl, 'https://raw.githubusercontent.com/foo/bar/main');
  });
});

test('install() writes exactly what it is passed, never merging with a previously stored value', () => {
  inCliSandbox((cli, home) => {
    // given — a first install with both values set
    cli.install('https://example.test', 'https://raw.githubusercontent.com/foo/bar/main');

    // when — install() is called again with different values (as main() only ever does
    // after validating both are present — see the run()/main() tests below)
    cli.install('https://example2.test', 'https://raw.githubusercontent.com/foo/baz/main');

    // then — the new values win outright; nothing is merged with the old config
    const config = JSON.parse(fs.readFileSync(configPath(home), 'utf8'));
    assert.equal(config.apiBaseUrl, 'https://example2.test');
    assert.equal(config.repoRawBaseUrl, 'https://raw.githubusercontent.com/foo/baz/main');
  });
});

test('parseApiBaseUrlArg reads both --api-base-url <url> and --api-base-url=<url> forms', () => {
  inCliSandbox(cli => {
    // given / when / then
    assert.equal(cli.parseApiBaseUrlArg(['install', '--api-base-url', 'https://a.test']), 'https://a.test');
    assert.equal(cli.parseApiBaseUrlArg(['install', '--api-base-url=https://b.test']), 'https://b.test');
    assert.equal(cli.parseApiBaseUrlArg(['install']), undefined);
  });
});

test('parseRepoUrlArg reads both --repo-raw-base-url <url> and --repo-raw-base-url=<url> forms, and is undefined when omitted', () => {
  inCliSandbox(cli => {
    // given / when / then
    assert.equal(
      cli.parseRepoUrlArg(['install', '--repo-raw-base-url', 'https://raw.githubusercontent.com/foo/bar/main']),
      'https://raw.githubusercontent.com/foo/bar/main'
    );
    assert.equal(
      cli.parseRepoUrlArg(['install', '--repo-raw-base-url=https://raw.githubusercontent.com/foo/bar/main']),
      'https://raw.githubusercontent.com/foo/bar/main'
    );
    assert.equal(cli.parseRepoUrlArg(['install']), undefined);
  });
});

test('extractCommand skips a value-flag\'s separate-token value instead of misparsing it as the command', () => {
  inCliSandbox(cli => {
    // given / when / then — the explicit command wins when present
    assert.equal(cli.extractCommand(['install', '--api-base-url', 'https://a.test']), 'install');
    // the URL after a known value-flag is not mistaken for the command, even with no
    // command word at all (a bare `npx <pkg> --api-base-url <url>` invocation)
    assert.equal(cli.extractCommand(['--api-base-url', 'https://a.test']), undefined);
    assert.equal(
      cli.extractCommand(['--api-base-url', 'https://a.test', '--repo-raw-base-url', 'https://b.test']),
      undefined
    );
    // the `--flag=value` form has no separate value token to skip
    assert.equal(cli.extractCommand(['--api-base-url=https://a.test']), undefined);
    assert.equal(cli.extractCommand(['uninstall']), 'uninstall');
  });
});

test('isPlausibleUrl accepts http(s) URLs and rejects everything else', () => {
  inCliSandbox(cli => {
    // given / when / then — default (requirePath: true) is used for --repo-raw-base-url,
    // which names a specific raw-files root, not a domain root
    assert.equal(cli.isPlausibleUrl('https://example.test/foo/bar/main'), true);
    assert.equal(cli.isPlausibleUrl('http://example.test/foo/bar/main'), false);
    assert.equal(cli.isPlausibleUrl('http://localhost/foo/bar'), true);
    assert.equal(cli.isPlausibleUrl('http://127.0.0.1:3000/foo'), true);
    assert.equal(cli.isPlausibleUrl('https://example.test'), false);
    assert.equal(cli.isPlausibleUrl('https://example.test/'), false);
    assert.equal(cli.isPlausibleUrl('anything'), false);
    assert.equal(cli.isPlausibleUrl('ftp://example.test/foo'), false);
    assert.equal(cli.isPlausibleUrl(''), false);

    // requirePath: false — used for --api-base-url, a bare origin the plugin appends its
    // own ingest path to
    assert.equal(cli.isPlausibleUrl('https://example.test', false), true);
    assert.equal(cli.isPlausibleUrl('https://example.test/', false), true);
    assert.equal(cli.isPlausibleUrl('anything', false), false);
    assert.equal(cli.isPlausibleUrl('ftp://example.test', false), false);
    assert.equal(cli.isPlausibleUrl('', false), false);
  });
});

test('the npx bin entry rejects an implausible --api-base-url (e.g. "anything")', () => {
  // given — an isolated $HOME, a non-URL --api-base-url value
  const { home, cleanup } = withTempHome();
  try {
    // when
    const res = spawnSync(process.execPath, [
      UPDATER_PATH, 'install',
      '--api-base-url', 'anything',
      '--repo-raw-base-url', 'https://raw.githubusercontent.com/foo/bar/main',
    ], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });

    // then — non-zero exit, explanatory error, nothing installed
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /valid http\(s\) URLs/);
    assert.equal(fs.existsSync(hookDest(home)), false);
  } finally {
    cleanup();
  }
});

test('the npx bin entry (node updater.js install --api-base-url <url> --repo-raw-base-url <url>) installs the hook', () => {
  // given — an isolated $HOME; updater.js is the registered `bin`, so npx runs it directly
  const { home, cleanup } = withTempHome();
  try {
    // when — invoke it as a child process exactly as npx would (main()'s argv dispatch)
    const res = spawnSync(process.execPath, [
      UPDATER_PATH, 'install',
      '--api-base-url', 'https://example.test',
      '--repo-raw-base-url', 'https://raw.githubusercontent.com/foo/bar/main',
    ], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });

    // then — the process succeeded and the hook was installed under the plugin dir
    assert.equal(res.status, 0, res.stderr);
    assert.equal(fs.existsSync(hookDest(home)), true);
    const config = JSON.parse(fs.readFileSync(configPath(home), 'utf8'));
    assert.equal(config.apiBaseUrl, 'https://example.test');
    assert.equal(config.repoRawBaseUrl, 'https://raw.githubusercontent.com/foo/bar/main');
  } finally {
    cleanup();
  }
});

test('the npx bin entry fails loudly without --api-base-url', () => {
  // given — an isolated $HOME, no --api-base-url passed (but --repo-raw-base-url is)
  const { home, cleanup } = withTempHome();
  try {
    // when
    const res = spawnSync(process.execPath, [
      UPDATER_PATH, 'install',
      '--repo-raw-base-url', 'https://raw.githubusercontent.com/foo/bar/main',
    ], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });

    // then — non-zero exit, explanatory error, nothing installed
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /--api-base-url/);
    assert.equal(fs.existsSync(hookDest(home)), false);
  } finally {
    cleanup();
  }
});

test('the npx bin entry fails loudly without --repo-raw-base-url', () => {
  // given — an isolated $HOME, no --repo-raw-base-url passed (but --api-base-url is)
  const { home, cleanup } = withTempHome();
  try {
    // when
    const res = spawnSync(process.execPath, [UPDATER_PATH, 'install', '--api-base-url', 'https://example.test'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });

    // then — non-zero exit, explanatory error, nothing installed
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /--repo-raw-base-url/);
    assert.equal(fs.existsSync(hookDest(home)), false);
  } finally {
    cleanup();
  }
});

test('the npx bin entry reinstall without --api-base-url fails — no fallback to a previously stored value', () => {
  // given — a first install with both required flags
  const { home, cleanup } = withTempHome();
  try {
    const first = spawnSync(process.execPath, [
      UPDATER_PATH, 'install',
      '--api-base-url', 'https://example.test',
      '--repo-raw-base-url', 'https://raw.githubusercontent.com/foo/bar/main',
    ], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    assert.equal(first.status, 0, first.stderr);

    // when — reinstalling without repeating --api-base-url (config.json is never
    // consulted as a fallback)
    const second = spawnSync(process.execPath, [
      UPDATER_PATH, 'install',
      '--repo-raw-base-url', 'https://raw.githubusercontent.com/foo/bar/main',
    ], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });

    // then — it refuses, and the stored api base url from the first install is untouched
    assert.notEqual(second.status, 0);
    const config = JSON.parse(fs.readFileSync(configPath(home), 'utf8'));
    assert.equal(config.apiBaseUrl, 'https://example.test');
  } finally {
    cleanup();
  }
});

test('the npx bin entry stores --repo-raw-base-url when passed', () => {
  // given — an isolated $HOME
  const { home, cleanup } = withTempHome();
  try {
    // when
    const res = spawnSync(process.execPath, [
      UPDATER_PATH, 'install',
      '--api-base-url', 'https://example.test',
      '--repo-raw-base-url', 'https://raw.githubusercontent.com/foo/bar/main',
    ], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });

    // then
    assert.equal(res.status, 0, res.stderr);
    const config = JSON.parse(fs.readFileSync(configPath(home), 'utf8'));
    assert.equal(config.repoRawBaseUrl, 'https://raw.githubusercontent.com/foo/bar/main');
  } finally {
    cleanup();
  }
});

test('readSettings exits when settings.json is not valid JSON', () => {
  inCliSandbox((cli, home) => {
    // given — a corrupt settings.json
    seedSettings(home, {});
    fs.writeFileSync(settingsPath(home), '{ broken json');
    const origExit = process.exit;
    const origErr = console.error;
    process.exit = code => {
      throw new Error(`exit:${code}`);
    };
    console.error = () => {};

    // when / then — reading bails out rather than returning garbage
    try {
      assert.throws(() => cli.readSettings(), /exit:1/);
    } finally {
      process.exit = origExit;
      console.error = origErr;
    }
  });
});

test('install copies statusline.js and registers it as the statusLine', () => {
  inCliSandbox((cli, home) => {
    // given — a fresh sandbox

    // when
    cli.install();

    // then
    assert.equal(fs.existsSync(statuslineDest(home)), true);
    const settings = readSettings(home);
    assert.equal(settings.statusLine.type, 'command');
    assert.ok(settings.statusLine.command.includes('statusline.js'));
    assert.ok(settings.statusLine.command.includes('$HOME/'));
  });
});

test('install leaves a pre-existing foreign statusLine untouched', () => {
  inCliSandbox((cli, home) => {
    // given — another tool already owns the statusLine
    seedSettings(home, { statusLine: { type: 'command', command: 'my-other-tool.sh' } });

    // when
    cli.install();

    // then
    const settings = readSettings(home);
    assert.equal(settings.statusLine.command, 'my-other-tool.sh');
  });
});

test('install leaves a statusline.js from an old plugin directory name untouched', () => {
  inCliSandbox((cli, home) => {
    // given — a stale entry from before a plugin rename, same basename but different dir
    seedSettings(home, {
      statusLine: { type: 'command', command: 'node "$HOME/.copilot/tokendashboard-plugin/statusline.js"' },
    });

    // when
    cli.install();

    // then
    const settings = readSettings(home);
    assert.equal(settings.statusLine.command, 'node "$HOME/.copilot/tokendashboard-plugin/statusline.js"');
  });
});

test('install is idempotent for statusLine — repeated runs don\'t duplicate or drift it', () => {
  inCliSandbox((cli, home) => {
    // given / when
    cli.install();
    cli.install();

    // then
    const settings = readSettings(home);
    assert.equal(settings.statusLine.type, 'command');
    assert.ok(settings.statusLine.command.includes('statusline.js'));
  });
});

test('uninstall removes statusline.js and our statusLine entry', () => {
  inCliSandbox((cli, home) => {
    // given
    cli.install();

    // when
    cli.uninstall();

    // then
    assert.equal(fs.existsSync(statuslineDest(home)), false);
    const settings = readSettings(home);
    assert.equal(settings.statusLine, undefined);
  });
});

test('uninstall leaves a foreign statusLine untouched', () => {
  inCliSandbox((cli, home) => {
    // given — our own statusLine plus a foreign one installed afterwards by hand
    cli.install();
    const settings = readSettings(home);
    settings.statusLine = { type: 'command', command: 'my-other-tool.sh' };
    fs.writeFileSync(settingsPath(home), JSON.stringify(settings, null, 2));

    // when
    cli.uninstall();

    // then — not ours (filename doesn't match), left alone
    const after = readSettings(home);
    assert.equal(after.statusLine.command, 'my-other-tool.sh');
  });
});

test('install() copies every file listed in package.json\'s pluginFiles manifest', () => {
  inCliSandbox((cli, home) => {
    // given — the real package.json's pluginFiles list; install() must not hardcode it
    cli.install();

    // then
    assert.deepEqual(require('../package.json').pluginFiles, ['hook.js', 'statusline.js']);
    assert.equal(fs.existsSync(hookDest(home)), true);
    assert.equal(fs.existsSync(statuslineDest(home)), true);
  });
});
