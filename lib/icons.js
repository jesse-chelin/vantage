'use strict';

// macOS application icons: locate the bundle's .icns, convert to PNG with sips,
// and cache the result on disk (keyed by path + mtime so updates invalidate).

const fs = require('node:fs/promises');
const fssync = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { run } = require('./exec');
const { assertAppPath } = require('./apps');

const ICON_DIR = path.join(__dirname, '..', 'data', 'icons');

async function resolveIcns(appPath) {
  const resources = path.join(appPath, 'Contents', 'Resources');
  const info = path.join(appPath, 'Contents', 'Info.plist');
  const candidates = [];
  const read = await run('/usr/libexec/PlistBuddy', ['-c', 'Print:CFBundleIconFile', info], { timeout: 5000 });
  if (read.ok) {
    const name = read.stdout.trim();
    if (name) candidates.push(name.toLowerCase().endsWith('.icns') ? name : `${name}.icns`);
  }
  candidates.push('AppIcon.icns', 'app.icns');
  for (const candidate of candidates) {
    const full = path.join(resources, candidate);
    try {
      if (fssync.statSync(full).isFile()) return full;
    } catch {
      /* not a file */
    }
  }
  try {
    const files = await fs.readdir(resources);
    const icns = files.find((file) => file.toLowerCase().endsWith('.icns'));
    if (icns) return path.join(resources, icns);
  } catch {
    /* no Resources dir */
  }
  return null;
}

// Returns the absolute path to a cached PNG, or null when no icon is available.
async function appIcon(input, size = 128) {
  const appPath = assertAppPath(input);
  const icns = await resolveIcns(appPath);
  if (!icns) return null;

  let mtime = 0;
  try {
    mtime = (await fs.stat(icns)).mtimeMs;
  } catch {
    /* ignore */
  }
  const key = crypto.createHash('sha1').update(`${appPath}:${mtime}:${size}`).digest('hex');
  const out = path.join(ICON_DIR, `${key}.png`);
  if (fssync.existsSync(out)) return out;

  await fs.mkdir(ICON_DIR, { recursive: true });
  const result = await run('/usr/bin/sips', ['-s', 'format', 'png', '-Z', String(size), icns, '--out', out], { timeout: 15_000 });
  return result.ok && fssync.existsSync(out) ? out : null;
}

module.exports = { appIcon, ICON_DIR };
