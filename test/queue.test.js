'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { inSandbox, queueDir } = require('./helpers.js');

test('getQueueFiles returns [] when the queue dir does not exist', () => {
  inSandbox(hook => {
    // given — a fresh sandbox with no queue dir

    // when
    const files = hook.getQueueFiles();

    // then
    assert.deepEqual(files, []);
  });
});

test('writeEntry creates the queue dir and a parseable entry file', () => {
  inSandbox((hook, home) => {
    // given
    const entry = { session_id: 's1', model: 'gpt-5.4-mini', usage: { input_tokens: 5 } };

    // when
    hook.writeEntry(entry);

    // then
    const files = hook.getQueueFiles();
    assert.equal(files.length, 1);
    assert.equal(path.dirname(files[0]), queueDir(home));
    assert.deepEqual(JSON.parse(fs.readFileSync(files[0], 'utf8')), entry);
  });
});

test('multiple writeEntry calls in one process produce unique files', () => {
  inSandbox(hook => {
    // given — three writes that may land in the same millisecond (multi-model session)

    // when
    hook.writeEntry({ n: 1 });
    hook.writeEntry({ n: 2 });
    hook.writeEntry({ n: 3 });

    // then — writeCounter guarantees unique filenames
    const files = hook.getQueueFiles();
    assert.equal(files.length, 3);
    assert.equal(new Set(files).size, 3);
  });
});

test('writeEntry publishes the entry atomically (rename, never a direct .json write)', () => {
  inSandbox(hook => {
    // given — spies on the shared fs singleton (hook.js writes through the same object)
    const directWrites = [];
    const renameTargets = [];
    const origWrite = fs.writeFileSync;
    const origRename = fs.renameSync;
    fs.writeFileSync = (p, ...rest) => {
      directWrites.push(p);
      return origWrite(p, ...rest);
    };
    fs.renameSync = (from, to) => {
      renameTargets.push(to);
      return origRename(from, to);
    };

    // when
    try {
      hook.writeEntry({ session_id: 's1', model: 'm', usage: { input_tokens: 1 } });
    } finally {
      fs.writeFileSync = origWrite;
      fs.renameSync = origRename;
    }

    // then — the live queue file is the rename target; no .json was ever written
    // directly (which would expose a half-written file to a concurrent flush).
    const queueFile = hook.getQueueFiles()[0];
    assert.ok(renameTargets.includes(queueFile));
    assert.ok(!directWrites.some(p => p.endsWith('.json')));
  });
});

test('getQueueFiles excludes the .lock dotfile and non-json files', () => {
  inSandbox((hook, home) => {
    // given — a queue dir with one entry plus noise files
    const dir = queueDir(home);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '123-1-0.json'), '{}');
    fs.writeFileSync(path.join(dir, '.lock'), '999');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignore me');

    // when
    const files = hook.getQueueFiles();

    // then
    assert.equal(files.length, 1);
    assert.ok(files[0].endsWith('123-1-0.json'));
  });
});
