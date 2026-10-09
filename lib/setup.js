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
const LAUNCHD_LABEL = 'local.vantage';

// Paths that macOS protects behind Full Disk Access. If we can read one, the
// server can see complete disk totals; EPERM/EACCES means it hasn't been granted.
const TCC_PROTECTED = [
  path.join(HOME, 'Library', 'Mail'),
  path.join(HOME, 'Library', 'Safari'),
  path.join(HOME, 'Library', 'Messages'),
];

// User folders macOS gates behind per-app TCC. Reading one is what makes macOS
// show its "would like to access files in…" prompt, so the wizard offers a
// button per folder and probes only when the user asks.
const FOLDER_ACCESS = [
  { id: 'desktop', label: 'Desktop', target: () => path.join(HOME, 'Desktop') },
  { id: 'documents', label: 'Documents', target: () => path.join(HOME, 'Documents') },
  { id: 'downloads', label: 'Downloads', target: () => path.join(HOME, 'Downloads') },
  { id: 'movies', label: 'Movies', target: () => path.join(HOME, 'Movies') },
  { id: 'music', label: 'Music', target: () => path.join(HOME, 'Music') },
  { id: 'pictures', label: 'Pictures', target: () => path.join(HOME, 'Pictures') },
  { id: 'photos', label: 'Photos library', target: () => path.join(HOME, 'Pictures', 'Photo Library.photoslibrary') },
];

async function requestFolderAccess(id) {
  const folder = FOLDER_ACCESS.find((entry) => entry.id === id);
  if (!folder) throw Object.assign(new Error('unknown folder'), { status: 400 });
  const target = folder.target();
  try {
    await fs.readdir(target);
    return { id, granted: true, path: target };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { id, granted: null, missing: true, path: target };
    return { id, granted: false, path: target };
  }
}

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

// The stable PATH symlink to the running Node binary (Homebrew puts one at
// /opt/homebrew/bin/node), which is friendlier to paste into Full Disk Access
// than the versioned Cellar path process.execPath resolves to.
function nodeBinaryPath() {
  const candidates = ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'];
  let real = null;
  try { real = fssync.realpathSync(process.execPath); } catch { /* ignore */ }
  if (real) {
    for (const candidate of candidates) {
      try {
        if (fssync.realpathSync(candidate) === real) return candidate;
      } catch { /* not present */ }
    }
  }
  return process.execPath;
}

async function status() {
  // Deliberately excludes the Full Disk Access probe: reading ~/Library/Mail
  // triggers macOS's "would like to access data from other apps" prompt. The
  // wizard asks for that only on an explicit, explained action.
  const [launchd, pwa] = await Promise.all([
    launchdLoaded(),
    settings.pwaInstalled().catch(() => false),
  ]);
  return {
    notifier: notify.macNotifier(),
    launchdLoaded: launchd,
    launchdLabel: LAUNCHD_LABEL,
    pwaInstalled: pwa,
    nodePath: nodeBinaryPath(),
    folders: FOLDER_ACCESS.map(({ id, label }) => ({ id, label })),
  };
}

module.exports = { status, fullDiskAccess, requestFolderAccess, LAUNCHD_LABEL };
