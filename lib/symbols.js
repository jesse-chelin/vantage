'use strict';

// SF Symbols for the UI, rendered by the compiled swift helper (bin/sfrender)
// straight from the system. Icons are cached as PNGs and served for use as CSS
// masks, so they inherit the theme colour. If swiftc is unavailable, or a
// symbol doesn't exist on this macOS, the id is simply absent from the catalog
// and the front end keeps its built-in line icon.

const fs = require('node:fs/promises');
const fssync = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { run } = require('./exec');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'bin', 'sfrender.swift');
const BIN = path.join(ROOT, 'bin', 'sfrender');
const DIR = path.join(ROOT, 'data', 'symbols');
const SIZE = 64;

// App icon id -> SF Symbol name. Missing names on this macOS are filtered by
// the availability check below.
const MAP = {
  overview: 'chart.line.uptrend.xyaxis',
  disk: 'internaldrive',
  brain: 'brain.head.profile',
  photo: 'photo',
  cube: 'cube',
  bot: 'cpu',
  gears: 'gearshape.2.fill',
  mug: 'cup.and.saucer',
  grid: 'square.grid.2x2',
  box: 'shippingbox',
  warning: 'exclamationmark.triangle',
  check: 'checkmark',
  download: 'arrow.down.circle',
  trash: 'trash',
  play: 'play.fill',
  stop: 'stop.fill',
  restart: 'arrow.clockwise',
  eye: 'eye',
  bolt: 'bolt.fill',
  xmark: 'xmark',
  chevron: 'chevron.down',
  back: 'chevron.left',
  star: 'star',
  search: 'magnifyingglass',
  gear: 'gearshape',
  pulse: 'waveform.path.ecg',
  shield: 'lock.shield',
  bell: 'bell',
  history: 'clock.arrow.circlepath',
  copy: 'doc.on.doc',
  shop: 'bag',
  user: 'person.crop.circle',
  network: 'network',
  cpu: 'cpu',
  memory: 'memorychip',
  swap: 'arrow.left.arrow.right',
  thermo: 'thermometer.medium',
  gpu: 'display',
  clock: 'clock',
  terminal: 'terminal',
  app: 'macwindow',
  globe: 'globe',
  layers: 'square.3.layers.3d',
  database: 'cylinder',
  key: 'key',
  upload: 'square.and.arrow.up',
  link: 'link',
  folder: 'folder',
  file: 'doc',
  sparkle: 'sparkles',
  sidebar: 'sidebar.left',
  monitor: 'display',
  film: 'film',
  music: 'music.note',
  camera: 'camera',
  fingerprint: 'touchid',
};

let helper = null; // null = unchecked, { ok, path }
let catalog = null; // id -> sf name (available)

// Cache key includes the helper source mtime and the symbol map, so editing
// either invalidates the on-disk PNGs and the URLs the front end requests.
const BUILD = (() => {
  let stamp = '0';
  for (const file of [SRC, BIN]) {
    try { stamp = String(fssync.statSync(file).mtimeMs); break; } catch { /* not present */ }
  }
  const mapHash = crypto.createHash('sha1').update(JSON.stringify(MAP)).digest('hex').slice(0, 8);
  return `${stamp}:${mapHash}`;
})();

function cacheName(sfName, size) {
  const hash = crypto.createHash('sha1').update(`${sfName}:${size}:${BUILD}`).digest('hex').slice(0, 12);
  return path.join(DIR, `${hash}.png`);
}

async function ensureHelper() {
  if (helper) return helper.ok ? BIN : null;
  let srcMtime = 0;
  try { srcMtime = (await fs.stat(SRC)).mtimeMs; } catch { /* missing source */ }
  try {
    if ((await fs.stat(BIN)).mtimeMs >= srcMtime) { helper = { ok: true, path: BIN }; return BIN; }
  } catch { /* not built yet */ }

  const compiler = fssync.existsSync('/usr/bin/swiftc') ? '/usr/bin/swiftc' : null;
  if (!compiler) { helper = { ok: false }; return null; }
  const result = await run(compiler, ['-O', SRC, '-o', BIN], { timeout: 120_000 });
  helper = { ok: result.ok && fssync.existsSync(BIN), path: BIN };
  return helper.ok ? BIN : null;
}

async function png(sfName, size) {
  const bin = await ensureHelper();
  if (!bin) return null;
  const out = cacheName(sfName, size);
  if (fssync.existsSync(out)) return out;
  await fs.mkdir(DIR, { recursive: true });
  const result = await run(bin, [sfName, String(size), out], { timeout: 20_000 });
  return result.ok && fssync.existsSync(out) ? out : null;
}

async function buildCatalog() {
  const bin = await ensureHelper();
  if (!bin) return {};
  await fs.mkdir(DIR, { recursive: true });

  const catalogOut = {};
  const pending = [];
  for (const [id, sfName] of Object.entries(MAP)) {
    if (fssync.existsSync(cacheName(sfName, SIZE))) catalogOut[id] = sfName;
    else pending.push([id, sfName]);
  }
  if (!pending.length) return catalogOut;

  const listFile = path.join(DIR, `.batch-${crypto.randomBytes(4).toString('hex')}.tsv`);
  await fs.writeFile(listFile, pending.map(([, sf]) => `${sf}\t${SIZE}\t${cacheName(sf, SIZE)}`).join('\n') + '\n').catch(() => {});
  const result = await run(bin, ['--batch', listFile], { timeout: 120_000 });
  await fs.unlink(listFile).catch(() => {});

  const ok = new Set();
  for (const line of result.stdout.split('\n')) {
    const [status, name] = line.split('\t');
    if (status === 'ok') ok.add(name);
  }
  for (const [id, sfName] of pending) if (ok.has(sfName)) catalogOut[id] = sfName;
  return catalogOut;
}

async function available() {
  if (!catalog) catalog = buildCatalog().catch(() => ({}));
  return catalog;
}

// Short token tied to the helper build, so the front end can cache-bust the
// symbol PNGs whenever the renderer changes.
async function token() {
  return crypto.createHash('sha1').update(BUILD).digest('hex').slice(0, 8);
}

async function icon(id, size = SIZE) {
  const list = await available();
  const sfName = list[id];
  if (!sfName) return null;
  return png(sfName, size);
}

// The catalog with each symbol inlined as a data URI, so the front end never
// has to request (or cache) the PNGs — the mask always matches this server.
let maskCache = null;
async function masks() {
  if (maskCache && maskCache.build === BUILD) return maskCache.data;
  const list = await available();
  const data = {};
  for (const id of Object.keys(list)) {
    const file = await png(list[id], SIZE);
    if (!file) continue;
    try {
      data[id] = `data:image/png;base64,${(await fs.readFile(file)).toString('base64')}`;
    } catch {
      /* skip */
    }
  }
  maskCache = { build: BUILD, data };
  return data;
}

module.exports = { available, icon, token, masks, MAP };
