'use strict';

// Device images straight from macOS: CoreTypes.bundle ships a transparent render
// of every Mac model, the same art the About sheet shows. We convert the right
// .icns to PNG once with sips and cache it, so it stays local, offline and
// CSP-clean.

const fs = require('node:fs/promises');
const fssync = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { run } = require('./exec');

const DIR = path.join(__dirname, '..', 'data', 'devices');
const CORE_TYPES = '/System/Library/CoreServices/CoreTypes.bundle/Contents/Resources';
const FFMPEG = fssync.existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg';

const ICONS = {
  'mac-studio': 'com.apple.macstudio.icns',
  'mac-mini': 'com.apple.macmini-2020.icns',
  'macbook-pro': 'com.apple.macbookpro-14-2021-silver.icns',
  'macbook-air': 'com.apple.macbookair-13-2022-midnight.icns',
  imac: 'com.apple.imac-2021-blue.icns',
  'mac-pro': 'com.apple.macpro-2019.icns',
};

function imageKey(model) {
  const m = String(model || '').toLowerCase();
  if (m.includes('macbook pro')) return 'macbook-pro';
  if (m.includes('macbook air')) return 'macbook-air';
  if (m.includes('macbook')) return 'macbook-pro';
  if (m.includes('imac')) return 'imac';
  if (m.includes('mac pro')) return 'mac-pro';
  if (m.includes('mini')) return 'mac-mini';
  return 'mac-studio';
}

async function deviceImage(model, size = 360) {
  const key = imageKey(model);
  const file = ICONS[key];
  if (!file) return null;
  const src = path.join(CORE_TYPES, file);
  if (!fssync.existsSync(src)) return null;

  let mtime = 0;
  try {
    mtime = (await fs.stat(src)).mtimeMs;
  } catch {
    /* ignore */
  }
  const hash = crypto.createHash('sha1').update(`${file}:${mtime}:${size}`).digest('hex').slice(0, 12);
  const out = path.join(DIR, `${key}-${hash}.png`);
  if (fssync.existsSync(out)) return out;

  await fs.mkdir(DIR, { recursive: true });
  const raw = path.join(DIR, `.raw-${hash}.png`);
  const result = await run('/usr/bin/sips', ['-s', 'format', 'png', '-Z', String(size), src, '--out', raw], { timeout: 20_000 });
  if (!result.ok || !fssync.existsSync(raw)) return null;
  const trimmed = await trimAlpha(raw, out, size).catch(() => false);
  if (!trimmed) await fs.rename(raw, out).catch(() => {});
  await fs.unlink(raw).catch(() => {});
  return fssync.existsSync(out) ? out : null;
}

// The CoreTypes renders are square with generous transparent margins; crop to
// the device so it sits tight in the hero and sidebar.
async function trimAlpha(src, out, size) {
  const scan = path.join(DIR, `.scan-${crypto.randomBytes(4).toString('hex')}.raw`);
  const dumped = await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-f', 'rawvideo', '-pix_fmt', 'rgba', scan], { timeout: 30_000 });
  const buf = await fs.readFile(scan).catch(() => null);
  await fs.unlink(scan).catch(() => {});
  if (!dumped.ok || !buf) return false;
  const W = size;
  const H = Math.round(buf.length / (size * 4));
  let minX = W;
  let minY = H;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      if (buf[(y * W + x) * 4 + 3] > 40) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return false;
  const pad = Math.round(Math.max(W, H) * 0.02);
  const x = Math.max(0, minX - pad);
  const y = Math.max(0, minY - pad);
  const w = Math.min(W - x, maxX - minX + pad * 2);
  const h = Math.min(H - y, maxY - minY + pad * 2);
  if (w <= 0 || h <= 0) return false;
  const crop = await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-vf', `crop=${w}:${h}:${x}:${y}`, '-frames:v', '1', '-update', '1', out], { timeout: 20_000 });
  return crop.ok && fssync.existsSync(out);
}

module.exports = { deviceImage, imageKey };
