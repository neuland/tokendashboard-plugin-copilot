'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { inSandbox, queueDir } = require('./helpers.js');

const DEAD_PID = 2147483647; // out of range — guaranteed no such process
const lockPath = home => path.join(queueDir(home), '.lock');

test('isProcessAlive: true for self, false for a non-existent pid', () => {
  inSandbox(hook => {
    // given / when / then
    assert.equal(hook.isProcessAlive(process.pid), true);
    assert.equal(hook.isProcessAlive(DEAD_PID), false);
  });
});

test('acquireLock succeeds on a free queue and writes our pid', () => {
  inSandbox((hook, home) => {
    // given — an existing queue dir with no lock
    fs.mkdirSync(queueDir(home), { recursive: true });

    // when
    const acquired = hook.acquireLock();

    // then
    assert.equal(acquired, true);
    assert.equal(fs.readFileSync(lockPath(home), 'utf8'), String(process.pid));
  });
});

test('releaseLock removes the lock file', () => {
  inSandbox((hook, home) => {
    // given — a held lock
    fs.mkdirSync(queueDir(home), { recursive: true });
    hook.acquireLock();

    // when
    hook.releaseLock();

    // then
    assert.equal(fs.existsSync(lockPath(home)), false);
  });
});

test('acquireLock fails when the lock is held by a live process', () => {
  inSandbox((hook, home) => {
    // given — a lock owned by a live process (the test runner itself)
    fs.mkdirSync(queueDir(home), { recursive: true });
    fs.writeFileSync(lockPath(home), String(process.pid));

    // when
    const acquired = hook.acquireLock();

    // then — acquisition fails and the live lock is left intact
    assert.equal(acquired, false);
    assert.equal(fs.readFileSync(lockPath(home), 'utf8'), String(process.pid));
  });
});

test('acquireLock steals a stale lock owned by a dead process', () => {
  inSandbox((hook, home) => {
    // given — a lock owned by a dead process
    fs.mkdirSync(queueDir(home), { recursive: true });
    fs.writeFileSync(lockPath(home), String(DEAD_PID));

    // when
    const acquired = hook.acquireLock();

    // then — the stale lock is stolen and now holds our pid
    assert.equal(acquired, true);
    assert.equal(fs.readFileSync(lockPath(home), 'utf8'), String(process.pid));
  });
});

test('acquireLock steals an empty lock file left by a killed creator', () => {
  inSandbox((hook, home) => {
    // given — an empty lock file: `wx` creates the file before the pid is written, so
    // a writer killed in that window leaves a 0-byte lock. A NaN pid must not be read
    // as a live holder, or the lock would wedge flush/update permanently.
    fs.mkdirSync(queueDir(home), { recursive: true });
    fs.writeFileSync(lockPath(home), '');

    // when
    const acquired = hook.acquireLock();

    // then — the orphaned lock is stolen and now holds our pid
    assert.equal(acquired, true);
    assert.equal(fs.readFileSync(lockPath(home), 'utf8'), String(process.pid));
  });
});

test('acquireLock steals a lock file with non-numeric garbage', () => {
  inSandbox((hook, home) => {
    // given — a corrupt lock file whose contents do not parse to a pid
    fs.mkdirSync(queueDir(home), { recursive: true });
    fs.writeFileSync(lockPath(home), 'not-a-pid');

    // when
    const acquired = hook.acquireLock();

    // then — treated as stale and stolen
    assert.equal(acquired, true);
    assert.equal(fs.readFileSync(lockPath(home), 'utf8'), String(process.pid));
  });
});

test('acquireLock does not double-acquire a lock a racing stealer revived', () => {
  inSandbox((hook, home) => {
    // given — a stale lock that a competing stealer takes over with its own LIVE lock in
    // the window between our staleness read and our atomic rename-aside takeover. Without
    // the verify-and-restore guard, the unconditional remove would steal the fresh live
    // lock and both processes would believe they hold it. Reproduce the race by mutating
    // the file from inside the rename syscall.
    fs.mkdirSync(queueDir(home), { recursive: true });
    fs.writeFileSync(lockPath(home), String(DEAD_PID));

    const realRename = fs.renameSync;
    let injected = false;
    fs.renameSync = (from, to) => {
      if (!injected && from === lockPath(home)) {
        injected = true;
        realRename.call(fs, from, to);             // move the (now ex-)stale lock aside
        fs.writeFileSync(to, String(process.pid)); // ...but a live stealer had revived it
        return;
      }
      return realRename.call(fs, from, to);
    };

    // when
    let acquired;
    try {
      acquired = hook.acquireLock();
    } finally {
      fs.renameSync = realRename;
    }

    // then — we must NOT have taken it; the live holder is restored intact and no
    // takeover temp file is left behind
    assert.equal(acquired, false);
    assert.equal(fs.readFileSync(lockPath(home), 'utf8'), String(process.pid));
    assert.equal(fs.existsSync(`${lockPath(home)}.steal.${process.pid}`), false);
  });
});
