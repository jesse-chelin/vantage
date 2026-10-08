'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vantage-settings-'));
process.env.VANTAGE_DATA_DIR = TMP;

const settings = require('../lib/settings');
const onboarding = require('../lib/onboarding');

test('settings.values returns defaults from the registry', async () => {
  const values = await settings.values();
  assert.equal(values['appearance.accent'], 'system');
  assert.equal(values['appearance.density'], 'comfortable');
  assert.equal(values['notifications.macos'], true);
  assert.equal(values['notifications.cooldownMinutes'], 30);
});

test('settings.patch writes across stores and coerces types', async () => {
  const values = await settings.patch({ 'appearance.accent': 'green', 'notifications.cooldownMinutes': '5', 'notifications.macos': false });
  assert.equal(values['appearance.accent'], 'green');
  assert.equal(values['notifications.cooldownMinutes'], 5);
  assert.equal(values['notifications.macos'], false);
  const prefs = JSON.parse(fs.readFileSync(path.join(TMP, 'prefs.json'), 'utf8'));
  assert.equal(prefs.accent, 'green');
  const notify = JSON.parse(fs.readFileSync(path.join(TMP, 'settings.json'), 'utf8'));
  assert.equal(notify.cooldownMinutes, 5);
});

test('settings.patch rejects unknown ids', async () => {
  await assert.rejects(settings.patch({ 'nope.nope': 1 }), /Unknown setting/);
});

test('settings.reset restores a section to defaults', async () => {
  const values = await settings.reset('appearance');
  assert.equal(values['appearance.accent'], 'system');
  // other sections untouched
  assert.equal(values['notifications.macos'], false);
});

test('settings export/import round-trips', async () => {
  await settings.patch({ 'appearance.accent': 'purple' });
  const dump = await settings.exportAll();
  assert.equal(dump.app, 'vantage');
  assert.equal(dump.prefs.accent, 'purple');
  await settings.patch({ 'appearance.accent': 'red' });
  const restored = await settings.importAll(dump);
  assert.equal(restored['appearance.accent'], 'purple');
});

test('onboarding state advances, completes and resets', async () => {
  let state = await onboarding.get();
  assert.equal(state.completedAt, null);
  state = await onboarding.update({ currentStep: 3 });
  assert.equal(state.currentStep, 3);
  assert.ok(state.startedAt, 'startedAt is stamped');
  state = await onboarding.update({ completedAt: 'now', steps: { security: { skipped: true } } });
  assert.equal(state.completedAt, 'now');
  state = await onboarding.reset();
  assert.equal(state.completedAt, null);
  assert.equal(state.currentStep, 0);
});

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});
