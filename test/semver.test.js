'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { semverGt } = require('../updater.js');

test('semverGt: greater patch / minor / major', () => {
  // given / when / then — each pair: left is the newer version
  assert.equal(semverGt('1.0.1', '1.0.0'), true);
  assert.equal(semverGt('1.1.0', '1.0.9'), true);
  assert.equal(semverGt('2.0.0', '1.9.9'), true);
});

test('semverGt: equal versions are not greater', () => {
  // given
  const a = '1.2.3', b = '1.2.3';

  // when
  const result = semverGt(a, b);

  // then
  assert.equal(result, false);
});

test('semverGt: smaller versions are not greater', () => {
  // given / when / then — left is the older version in every pair
  assert.equal(semverGt('1.0.0', '1.0.1'), false);
  assert.equal(semverGt('1.0.9', '1.1.0'), false);
  assert.equal(semverGt('1.9.9', '2.0.0'), false);
});

test('semverGt: minor outranks patch', () => {
  // given — 0.2.0 must count as an update over 0.1.99 (real rollout scenario)
  const remote = '0.2.0', current = '0.1.99';

  // when
  const result = semverGt(remote, current);

  // then
  assert.equal(result, true);
});

test('semverGt: a malformed version is never treated as newer', () => {
  // given / when / then — a non-numeric segment must not silently stall the rollout
  // by comparing as NaN; it is rejected as "not greater" in either position
  assert.equal(semverGt('0.3.0-beta', '0.2.0'), false);
  assert.equal(semverGt('0.3.0', '0.2.0-beta'), false);
  assert.equal(semverGt('garbage', '0.2.0'), false);
});

test('semverGt: a short version pads missing segments with 0', () => {
  // given / when / then — "1.2" means "1.2.0", so it is not newer than "1.2.0"
  // but is newer than "1.1.9"
  assert.equal(semverGt('1.2', '1.2.0'), false);
  assert.equal(semverGt('1.2', '1.1.9'), true);
});
