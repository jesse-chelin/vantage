'use strict';

// First-run setup diagnostics, what a fresh install still needs. Used by the
// onboarding "Finish setup" step so it can auto-configure or open the exact
// System Settings pane for anything that can't be automated.

const fs = require('node:fs/promises');
const fssync = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { run } = require('./exec');
const notify = require('./notify');
const settings = require('./settings');

const HOME = os.homedir();
const LAUNCHD_LABEL = 'local.ai-dashboard';

// Paths that macOS protects behind Full Disk Access. If we can read one, the
// server can see complete disk totals; EPERM/EACCES means it hasn't been granted.
const TCC_PROTECTED = [
  path.join(HOME, 'Library', 'Mail'),
  path.join(HOME, 'Library', 'Safari'),
  path.join(HOME, 'Library', 'Messages'),
];

async function fullDiskAccess() {
  let sawExisting = false;
  for (const dir of TCC_PROTECTED) {
    try {
      await fs.access(dir, fssync.constants.R_OK);
      return true;
    } catch (error) {
      const code = error && error.code;
      if (code === 'EACCES' || code === 'EPERM') return false;
      if (code !== 'ENOENT') sawExisting = true;
    }
  }
  return sawExisting ? true : null; // none present → can't determine
}

async function launchdLoaded(label = LAUNCHD_LABEL) {
  const result = await run('/bin/launchctl', ['list'], { timeout: 5000 });
  return Boolean(result.ok && result.stdout.split('\n').some((line) => line.trim().split(/\s+/).pop() === label));
}

async function status() {
  const [fullDisk, launchd, pwa] = await Promise.all([
    fullDiskAccess(),
    launchdLoaded(),
    settings.pwaInstalled().catch(() => false),
  ]);
  return {
    notifier: notify.macNotifier(),
    fullDiskAccess: fullDisk,
    launchdLoaded: launchd,
    launchdLabel: LAUNCHD_LABEL,
    pwaInstalled: pwa,
  };
}

module.exports = { status, LAUNCHD_LABEL };
