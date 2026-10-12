'use strict';

// macOS application bundles: metadata from Info.plist, size, contents.

const os = require('node:os');
const path = require('node:path');

const { run, listDir, statSafe, duOne } = require('./exec');

const HOME = os.homedir();
const APP_ROOTS = ['/Applications', path.join(HOME, 'Applications'), '/System/Applications'];

function assertAppPath(input) {
  const resolved = path.resolve(String(input || ''));
  if (!resolved.endsWith('.app')) {
    const error = new Error('Not an application bundle');
    error.status = 400;
    throw error;
  }
  if (!APP_ROOTS.some((root) => resolved.startsWith(root + path.sep))) {
    const error = new Error('Application is outside the allowed folders');
    error.status = 403;
    throw error;
  }
  return resolved;
}

async function detail(input) {
  const appPath = assertAppPath(input);
  const infoPath = path.join(appPath, 'Contents', 'Info.plist');
  const plist = async (key) => {
    const result = await run('/usr/libexec/PlistBuddy', ['-c', `Print:${key}`, infoPath], { timeout: 6000 });
    return result.ok ? result.stdout.trim() : null;
  };

  const bundleName = await plist('CFBundleName');
  const displayName = (await plist('CFBundleDisplayName')) || bundleName || path.basename(appPath, '.app');
  const [bundleId, shortVersion, buildVersion, minOS, executable, size, stat, contents] = await Promise.all([
    plist('CFBundleIdentifier'),
    plist('CFBundleShortVersionString'),
    plist('CFBundleVersion'),
    plist('LSMinimumSystemVersion'),
    plist('CFBundleExecutable'),
    duOne(appPath, { timeout: 60000 }),
    statSafe(appPath),
    listDir(path.join(appPath, 'Contents')).then((entries) => entries.map((e) => e.name)),
  ]);

  let arch = null;
  if (executable) {
    const result = await run('/usr/bin/lipo', ['-archs', path.join(appPath, 'Contents', 'MacOS', executable)], { timeout: 5000 });
    if (result.ok && result.stdout.trim()) arch = result.stdout.trim();
  }

  const [codesign, quarantine] = await Promise.all([
    run('/usr/bin/codesign', ['-dv', '--verbose=2', appPath], { timeout: 8000 }),
    run('/usr/bin/xattr', ['-p', 'com.apple.quarantine', appPath], { timeout: 5000 }),
  ]);
  const signatureText = `${codesign.stderr}\n${codesign.stdout}`;
  const authority = (signatureText.match(/Authority=([^\n]+)/) || [])[1] || null;
  const teamId = (signatureText.match(/TeamIdentifier=([^\n]+)/) || [])[1] || null;
  const signed = /Authority=/.test(signatureText) ? true : /code object is not signed/i.test(signatureText) ? false : null;

  return {
    path: appPath,
    name: displayName,
    bundleId,
    shortVersion,
    buildVersion,
    minOS,
    executable,
    arch,
    size,
    modifiedAt: stat ? stat.mtime.toISOString() : null,
    contents,
    system: appPath.startsWith('/System/'),
    signature: { signed, authority, teamId },
    quarantined: quarantine.ok,
  };
}

// User-level files an app leaves behind, matched by bundle id and name. These
// are the usual suspects AppCleaner-style tools look at; macOS system locations
// (/Library, /var) are intentionally left alone.
const LEFT_OVER_DIRS = [
  ['Application Support', 'Application Support'],
  ['Caches', 'Cache'],
  ['Saved Application State', 'Saved state'],
  ['Containers', 'Container'],
  ['WebKit', 'WebKit data'],
  ['HTTPStorages', 'HTTP storage'],
  ['Application Scripts', 'App scripts'],
  ['Logs', 'Logs'],
];

async function leftovers(input) {
  const appPath = assertAppPath(input);
  let bundleId = null;
  let name = path.basename(appPath, '.app');
  try {
    const info = await detail(appPath);
    bundleId = info.bundleId;
    name = info.name || name;
  } catch {
    /* fall back to the folder name */
  }

  const library = path.join(HOME, 'Library');
  const candidates = new Map(); // absolute path -> kind
  const add = (target, kind) => {
    if (target) candidates.set(path.resolve(target), kind);
  };

  for (const [folder, kind] of LEFT_OVER_DIRS) {
    if (bundleId) add(path.join(library, folder, bundleId), kind);
    add(path.join(library, folder, name), kind);
  }
  if (bundleId) add(path.join(library, 'Preferences', `${bundleId}.plist`), 'Preferences');

  // A few locations hold many bundles per folder, so match by prefix.
  const patternDirs = [
    ['Group Containers', (entry) => bundleId && entry.includes(bundleId), 'Group container'],
    ['LaunchAgents', (entry) => bundleId && entry.startsWith(bundleId) && entry.endsWith('.plist'), 'Launch agent'],
    ['Preferences', (entry) => bundleId && entry.startsWith(bundleId) && entry.endsWith('.plist'), 'Preferences'],
  ];
  for (const [folder, test, kind] of patternDirs) {
    for (const entry of await listDir(path.join(library, folder))) {
      if (test(entry.name)) add(path.join(library, folder, entry.name), kind);
    }
  }

  const items = [];
  let totalBytes = 0;
  for (const [target, kind] of candidates) {
    const stat = await statSafe(target);
    if (!stat) continue;
    const bytes = stat.isDirectory() ? (await duOne(target, { timeout: 30_000 })) || 0 : stat.size;
    items.push({ path: target, kind, bytes, directory: stat.isDirectory() });
    totalBytes += bytes;
  }
  items.sort((a, b) => (b.bytes || 0) - (a.bytes || 0));

  return { app: { name, path: appPath, bundleId }, items, totalBytes, count: items.length };
}

module.exports = { detail, leftovers, assertAppPath, APP_ROOTS };
