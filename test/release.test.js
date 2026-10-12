'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { nextVersion, parseVersion, formatVersion } = require('../bin/release');

test('release bumps keep the prerelease line and honour --stable', () => {
  assert.equal(nextVersion('0.9.0-beta', 'patch'), '0.9.1-beta');
  assert.equal(nextVersion('0.9.0-beta', 'minor'), '0.10.0-beta');
  assert.equal(nextVersion('0.9.0-beta', 'major'), '1.0.0-beta');
  assert.equal(nextVersion('0.9.0-beta', 'stable'), '0.9.0');
  assert.equal(nextVersion('0.9.0', 'minor'), '0.10.0');
  assert.equal(nextVersion('0.9.0-beta', 'minor', { stable: true }), '0.10.0');
});

test('release accepts an explicit version and a --pre override', () => {
  assert.equal(nextVersion('0.9.0-beta', '1.2.3'), '1.2.3');
  assert.equal(nextVersion('0.9.0-beta', '0.10.0-rc.1'), '0.10.0-rc.1');
  assert.equal(nextVersion('0.9.0-beta', 'minor', { pre: 'rc' }), '0.10.0-rc');
});

test('release version helpers round-trip', () => {
  assert.deepEqual(parseVersion('2.3.4-rc.2'), { major: 2, minor: 3, patch: 4, pre: 'rc.2' });
  assert.equal(formatVersion({ major: 2, minor: 3, patch: 4, pre: null }), '2.3.4');
  assert.equal(formatVersion({ major: 2, minor: 3, patch: 4, pre: 'beta' }), '2.3.4-beta');
});

test('release rejects an unknown bump type', () => {
  assert.throws(() => nextVersion('0.9.0-beta', 'banana'), /Unknown bump/);
});
