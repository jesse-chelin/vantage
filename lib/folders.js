'use strict';

// Real macOS folder icons, pulled from CoreTypes.bundle (the same art Finder
// shows) plus the Photos app bundle, converted to PNG with sips and cached.

const fs = require('node:fs/promises');
const fssync = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { run } = require('./exec');

const DIR = path.join(__dirname, '..', 'data', 'folder-icons');
const CORE_TYPES = '/System/Library/CoreServices/CoreTypes.bundle/Contents/Resources';

const SOURCES = {
  desktop: path.join(CORE_TYPES, 'DesktopFolderIcon.icns'),
  documents: path.join(CORE_TYPES, 'DocumentsFolderIcon.icns'),
  downloads: path.join(CORE_TYPES, 'DownloadsFolder.icns'),
  movies: path.join(CORE_TYPES, 'MovieFolderIcon.icns'),
  music: path.join(CORE_TYPES, 'MusicFolderIcon.icns'),
  pictures: path.join(CORE_TYPES, 'PicturesFolderIcon.icns'),
  photos: '/System/Applications/Photos.app/Contents/Resources/AppIcon.icns',
  default: path.join(CORE_TYPES, 'GenericFolderIcon.icns'),
};

async function folderIcon(id, size = 64) {
  const src = SOURCES[id] || SOURCES.default;
  if (!fssync.existsSync(src)) return null;

  let mtime = 0;
  try {
    mtime = (await fs.stat(src)).mtimeMs;
  } catch {
    /* ignore */
  }
  const hash = crypto.createHash('sha1').update(`${src}:${mtime}:${size}`).digest('hex').slice(0, 12);
  const out = path.join(DIR, `${id}-${size}-${hash}.png`);
  if (fssync.existsSync(out)) return out;

  await fs.mkdir(DIR, { recursive: true });
  const result = await run('/usr/bin/sips', ['-s', 'format', 'png', '-Z', String(size), src, '--out', out], { timeout: 15_000 });
  return result.ok && fssync.existsSync(out) ? out : null;
}

module.exports = { folderIcon };
