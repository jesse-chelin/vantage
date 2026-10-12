'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');

const apps = require('../lib/apps');

test('apps.leftovers only accepts real application bundles', async () => {
  await assert.rejects(apps.leftovers('/tmp/not-an-app'), /application bundle/i);
  await assert.rejects(apps.leftovers(path.join(os.homedir(), 'Documents', 'Thing.app')), /allowed folders/i);
});

test('apps.leftovers is exported alongside detail', () => {
  assert.equal(typeof apps.leftovers, 'function');
  assert.equal(typeof apps.detail, 'function');
  assert.ok(Array.isArray(apps.APP_ROOTS));
});
