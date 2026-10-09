'use strict';

// Native document icons by file category, taken from CoreTypes.bundle (the art
// Finder/macOS uses). No file reads happen here, so an icon request can never
// trip a TCC prompt; the category comes from the file name alone.

const fs = require('node:fs/promises');
const fssync = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { run } = require('./exec');

const DIR = path.join(__dirname, '..', 'data', 'file-icons');
const CORE_TYPES = '/System/Library/CoreServices/CoreTypes.bundle/Contents/Resources';

const SOURCES = {
  picture: path.join(CORE_TYPES, 'ClippingPicture.icns'),
  sound: path.join(CORE_TYPES, 'ClippingSound.icns'),
  video: '/System/Applications/QuickTime Player.app/Contents/Resources/AppIcon.icns',
  disk: '/System/Library/PrivateFrameworks/DiskImages.framework/Versions/A/Resources/CDiskImage.icns',
  text: path.join(CORE_TYPES, 'ClippingText.icns'),
  font: path.join(CORE_TYPES, 'GenericFontIcon.icns'),
  archive: path.join(CORE_TYPES, 'GenericDocumentIcon.icns'),
  document: path.join(CORE_TYPES, 'GenericDocumentIcon.icns'),
};

const EXT = {
  picture: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'tiff', 'tif', 'bmp', 'svg', 'ico', 'icns', 'raw', 'psd', 'avif'],
  sound: ['mp3', 'm4a', 'wav', 'aac', 'flac', 'ogg', 'aiff', 'aif', 'mid', 'midi'],
  video: ['mp4', 'mov', 'm4v', 'mkv', 'avi', 'webm', 'wmv', 'flv', 'mpg', 'mpeg', '3gp', 'ts'],
  disk: ['dmg', 'iso', 'img', 'sparseimage', 'sparsebundle', 'toast', 'cdr'],
  font: ['ttf', 'otf', 'woff', 'woff2', 'ttc'],
  archive: ['zip', 'gz', 'tgz', 'tar', '7z', 'rar', 'bz2', 'xz', 'pkg'],
  text: ['txt', 'md', 'markdown', 'rtf', 'json', 'jsonc', 'js', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'sh', 'zsh', 'bash', 'yml', 'yaml', 'toml', 'ini', 'conf', 'cfg', 'env', 'plist', 'html', 'htm', 'css', 'scss', 'xml', 'csv', 'tsv', 'log', 'lock', 'sql'],
};

function category(name) {
  const ext = String(name || '').split('.').pop().toLowerCase();
  for (const [cat, list] of Object.entries(EXT)) if (list.includes(ext)) return cat;
  return 'document';
}

async function fileIcon(name, size = 48) {
  const cat = category(name);
  const src = SOURCES[cat] || SOURCES.document;
  if (!fssync.existsSync(src)) return null;

  let mtime = 0;
  try {
    mtime = (await fs.stat(src)).mtimeMs;
  } catch {
    /* ignore */
  }
  const hash = crypto.createHash('sha1').update(`${src}:${mtime}:${size}`).digest('hex').slice(0, 12);
  const out = path.join(DIR, `${cat}-${size}-${hash}.png`);
  if (fssync.existsSync(out)) return out;

  await fs.mkdir(DIR, { recursive: true });
  const result = await run('/usr/bin/sips', ['-s', 'format', 'png', '-Z', String(size), src, '--out', out], { timeout: 15_000 });
  return result.ok && fssync.existsSync(out) ? out : null;
}

module.exports = { fileIcon, category };
