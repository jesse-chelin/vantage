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

module.exports = { detail, assertAppPath, APP_ROOTS };
