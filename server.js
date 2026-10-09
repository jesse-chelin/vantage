'use strict';

// Local dashboard server. Zero external dependencies.
//
//   GET  /                     -> dashboard UI
//   GET  /api/session          -> session token + mode
//   GET  /api/inventory        -> cached inventory + scan status
//   POST /api/scan             -> start a background scan
//   GET  /api/actions          -> available management actions
//   POST /api/actions/:id      -> run an action
//   GET  /api/jobs             -> recent jobs
//   GET  /api/jobs/:id         -> job output (supports ?cursor=)
//   GET  /api/health           -> liveness

const http = require('node:http');
const fs = require('node:fs/promises');
const fssync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const APP_VERSION = require('./package.json').version;
// Changes on every process start; lets the client detect a restart after an update.
const BOOT_ID = crypto.randomBytes(6).toString('hex');

const { scanAll } = require('./lib/scanner');
const { run } = require('./lib/exec');
const { listActions, getActionMeta, runAction, undoAction, getJob, listJobs, openclawState, HttpError } = require('./lib/actions');
const hf = require('./lib/hf');

const metrics = require('./lib/metrics');
const disk = require('./lib/disk');
const health = require('./lib/health');
const security = require('./lib/security');
const notify = require('./lib/notify');
const agent = require('./lib/agent');
const gallery = require('./lib/gallery');
const apps = require('./lib/apps');
const store = require('./lib/store');
const profile = require('./lib/profile');
const modelInsights = require('./lib/models');
const overview = require('./lib/overview');
const comfy = require('./lib/comfy');
const pkgMeta = require('./lib/packages');
const files = require('./lib/files');
const cache = require('./lib/cache');
const network = require('./lib/network');
const brew = require('./lib/brew');
const icons = require('./lib/icons');
const device = require('./lib/device');
const folders = require('./lib/folders');
const fileicons = require('./lib/fileicons');
const symbols = require('./lib/symbols');
const maintenance = require('./lib/maintenance');
const rules = require('./lib/rules');
const schedule = require('./lib/schedule');
const system = require('./lib/system');
const native = require('./lib/native');
const diag = require('./lib/diag');
const webauthn = require('./lib/webauthn');
const push = require('./lib/push');
const settings = require('./lib/settings');
const onboarding = require('./lib/onboarding');
const setup = require('./lib/setup');
const update = require('./lib/update');
const changelog = require('./lib/changelog');

diag.install();

const PORT = Number(process.env.PORT || 8790);
const HOST = process.env.HOST || '127.0.0.1';
const READ_ONLY = process.env.READ_ONLY === '1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const CACHE_FILE = path.join(DATA_DIR, 'inventory.json');
const METRICS_DB = path.join(DATA_DIR, 'metrics.db');
const CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

// A token guards POSTs. A cross-site page cannot read it (no CORS headers,
// same-origin policy), so it cannot forge management requests. It is persisted
// so a server restart does not invalidate already-open dashboard tabs.
const TOKEN_FILE = path.join(DATA_DIR, 'dashboard-token');
function loadOrCreateToken() {
  try {
    const existing = fssync.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (existing) return existing;
  } catch {
    /* no token yet */
  }
  const token = crypto.randomBytes(24).toString('hex');
  try {
    fssync.mkdirSync(DATA_DIR, { recursive: true });
    fssync.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  } catch {
    /* fall back to in-memory token */
  }
  return token;
}
const TOKEN = loadOrCreateToken();

const state = {
  scanning: false,
  scanningDeep: null,
  progress: null,
  generatedAt: null,
  durationMs: null,
  error: null,
  data: null,
  deepScan: null,
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

// Applied to every response. styles/materials are inline, and Inter is loaded
// from Google Fonts, so those are the only allowances.
const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; script-src 'self'; worker-src 'self'; manifest-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

async function loadCache() {
  try {
    const raw = await fs.readFile(CACHE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.data) {
      state.data = parsed.data;
      state.generatedAt = parsed.generatedAt || parsed.data.generatedAt || null;
    }
  } catch {
    /* first run */
  }
}

async function saveCache() {
  if (!state.data) return;
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const payload = JSON.stringify({ generatedAt: state.generatedAt, durationMs: state.durationMs, data: state.data });
    const tmp = `${CACHE_FILE}.tmp`;
    await fs.writeFile(tmp, payload);
    await fs.rename(tmp, CACHE_FILE);
  } catch (error) {
    console.error('[cache] failed to write:', error.message);
  }
}

function startScan(options = {}) {
  if (state.scanning) return false;
  const deep = options.deep !== false;
  state.scanning = true;
  state.scanningDeep = deep;
  state.progress = 'Starting scan';
  state.error = null;

  const startedAt = Date.now();
  scanAll((label) => {
    state.progress = label;
  }, { deep })
    .then(async (data) => {
      state.data = data;
      state.generatedAt = data.generatedAt;
      state.durationMs = Date.now() - startedAt;
      state.error = null;
      state.deepScan = deep;
      overview.clearCache();
      cache.clear();
      brew.clearCache();
      await saveCache();
      console.log(`[scan] completed in ${(state.durationMs / 1000).toFixed(1)}s${deep ? '' : ' (quick, folder access pending setup)'}`);
    })
    .catch((error) => {
      state.error = error && error.stack ? error.stack : String(error);
      console.error('[scan] failed:', error);
    })
    .finally(() => {
      state.scanning = false;
      state.progress = null;
      if (pendingDeepScan && !deep) {
        pendingDeepScan = false;
        startScan({ deep: true });
      }
    });

  return true;
}

function cacheIsStale() {
  if (!state.generatedAt) return true;
  const age = Date.now() - new Date(state.generatedAt).getTime();
  return Number.isNaN(age) || age > CACHE_MAX_AGE_MS;
}

// The notification watcher can post real macOS banners (disk low, jobs, update),
// which trigger a system permission prompt the first time. Keep it quiet until
// onboarding has explained notifications; the wizard starts it when it finishes.
let notifyWatcherStarted = false;
function startNotifyWatcher() {
  if (notifyWatcherStarted) return;
  notifyWatcherStarted = true;
  notify.startWatcher({ getSample: metrics.getLatest, listJobs, endpointChecks: health.endpointChecks });
}

// Called when the wizard reports completion: now it's safe to read the user's
// home folders and turn on background banners.
let pendingDeepScan = false;
function afterOnboardingComplete() {
  startNotifyWatcher();
  const needsDeep = !state.data || state.deepScan === false || cacheIsStale();
  if (!needsDeep) return;
  if (state.scanning) {
    if (state.scanningDeep === false) pendingDeepScan = true;
  } else {
    startScan({ deep: true });
  }
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new HttpError(413, 'Request body too large'));
        req.destroy();
        return;
      }
      raw += chunk;
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, 'Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function authorized(req) {
  const header = req.headers['x-dashboard-token'];
  if (header !== TOKEN) return false;
  const origin = req.headers.origin;
  if (origin) {
    try {
      const host = new URL(origin).host;
      if (host !== req.headers.host) return false;
    } catch {
      return false;
    }
  }
  return true;
}

async function serveStatic(res, urlPath) {
  const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const resolved = path.resolve(PUBLIC_DIR, relative);
  if (!resolved.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) throw new Error('not a file');
    const ext = path.extname(resolved).toLowerCase();

    // Version the shell assets by their mtime so an updated app.js/styles.css is
    // always fetched, no matter how aggressively the browser or service worker
    // cached the previous copy.
    if (relative === 'index.html') {
      const token = await assetToken();
      const html = (await fs.readFile(resolved, 'utf8'))
        .replace('href="/styles.css"', `href="/styles.css?v=${token}"`)
        .replace('src="/app.js"', `src="/app.js?v=${token}"`);
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html), 'Cache-Control': 'no-store' });
      res.end(html);
      return;
    }

    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-store',
    });
    fssync.createReadStream(resolved).pipe(res);
  } catch {
    res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

async function assetToken() {
  try {
    const [a, s] = await Promise.all([
      fs.stat(path.join(PUBLIC_DIR, 'app.js')),
      fs.stat(path.join(PUBLIC_DIR, 'styles.css')),
    ]);
    return `${(a.mtimeMs ^ s.mtimeMs).toString(36)}`;
  } catch {
    return BOOT_ID;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  try {
    if (pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, scanning: state.scanning, boot: BOOT_ID, version: APP_VERSION });
    }

    if (pathname === '/api/diagnostics') {
      return sendJson(res, 200, { entries: diag.list(), cache: cache.stats() });
    }

    if (pathname === '/api/maintenance') {
      return sendJson(res, 200, { ...(await maintenance.status()), native: { built: native.exists() } });
    }

    if (pathname === '/api/system') {
      return sendJson(res, 200, await system.info());
    }

    if (pathname === '/api/rules') {
      if (req.method === 'POST') {
        if (!authorized(req)) return sendJson(res, 403, { error: 'Forbidden' });
        const body = await readBody(req);
        if (body && body.delete) {
          await rules.remove(body.delete);
          return sendJson(res, 200, { rules: await rules.list() });
        }
        if (body && body.seed) {
          const seeded = await rules.seedDefaults();
          return sendJson(res, 200, { seeded: seeded.added, rules: seeded.rules });
        }
        const rule = await rules.upsert(body || {});
        return sendJson(res, 200, { rule, rules: await rules.list() });
      }
      return sendJson(res, 200, { rules: await rules.list(), metrics: rules.METRICS, defaults: rules.DEFAULTS });
    }

    if (pathname === '/api/schedule') {
      if (req.method === 'POST') {
        if (!authorized(req)) return sendJson(res, 403, { error: 'Forbidden' });
        const body = await readBody(req);
        if (body && body.delete) {
          await schedule.remove(body.delete);
          return sendJson(res, 200, { tasks: await schedule.list() });
        }
        const task = await schedule.upsert(body || {});
        return sendJson(res, 200, { task, tasks: await schedule.list() });
      }
      return sendJson(res, 200, { tasks: await schedule.list() });
    }

    if (pathname === '/api/session') {
      return sendJson(res, 200, { token: TOKEN, readOnly: READ_ONLY, uid: typeof process.getuid === 'function' ? process.getuid() : null });
    }

    if (pathname === '/api/inventory') {
      return sendJson(res, 200, {
        scanning: state.scanning,
        progress: state.progress,
        generatedAt: state.generatedAt,
        durationMs: state.durationMs,
        error: state.error,
        stale: cacheIsStale(),
        data: state.data,
      });
    }

    if (pathname === '/api/actions') {
      return sendJson(res, 200, { readOnly: READ_ONLY, actions: listActions() });
    }

    if (pathname === '/api/openclaw') {
      return sendJson(res, 200, await openclawState());
    }

    if (pathname === '/api/history') {
      const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit')) || 100));
      return sendJson(res, 200, { actions: metrics.queryActions(limit) });
    }

    if (pathname.startsWith('/api/undo/') && req.method === 'POST') {
      if (READ_ONLY) return sendJson(res, 403, { error: 'Dashboard is in read-only mode' });
      if (!authorized(req)) return sendJson(res, 403, { error: 'Forbidden' });
      const id = pathname.slice('/api/undo/'.length);
      return sendJson(res, 200, await undoAction(id));
    }

    if (pathname === '/api/jobs' && req.method === 'GET') {
      return sendJson(res, 200, { jobs: listJobs() });
    }

    if (pathname === '/api/metrics/live') {
      return sendJson(res, 200, { sample: metrics.getLatest(), intervalMs: metrics.intervalMs });
    }

    if (pathname === '/api/metrics/series') {
      const minutes = Math.max(1, Math.min(10_080, Number(url.searchParams.get('minutes')) || 60));
      return sendJson(res, 200, { minutes, samples: metrics.querySeries(Date.now() - minutes * 60_000) });
    }

    if (pathname === '/api/disk/tree') {
      const target = url.searchParams.get('path') || os.homedir();
      return sendJson(res, 200, await disk.diskTree(target));
    }

    if (pathname === '/api/models/usage') {
      return sendJson(res, 200, { usage: metrics.getModelUsage(), benchmarks: metrics.getBenchmarks() });
    }

    if (pathname === '/api/models/insights') {
      return sendJson(res, 200, modelInsights.insights(state.data || {}, metrics.getModelUsage()));
    }

    if (pathname === '/api/models/detail') {
      const name = url.searchParams.get('name');
      const inv = state.data || {};
      const model = (inv.ollama && inv.ollama.models ? inv.ollama.models : []).find((m) => m.name === name);
      if (!model) return sendJson(res, 404, { error: 'Model not found' });
      const insights = modelInsights.insights(inv, metrics.getModelUsage());
      const insight = insights.models.find((m) => m.name === name) || null;
      const oc = (inv.agentStack && inv.agentStack.openclaw) || {};
      const base = (s) => String(s || '').split('/').pop().split(':')[0];
      const roles = [];
      if (base(oc.primaryModel) === base(name)) roles.push('primary');
      if (base(oc.utilityModel) === base(name)) roles.push('utility');
      if (base(oc.subagentModel) === base(name)) roles.push('subagent');
      if (base(oc.imageModel) === base(name)) roles.push('image');
      for (const [key, cfg] of Object.entries(oc.aliasModels || {})) if (base(key) === base(name)) roles.push(`alias · ${cfg.alias}`);
      const loaded = (inv.ollama && inv.ollama.loaded ? inv.ollama.loaded : []).find((m) => m.name === name) || null;
      return sendJson(res, 200, { model, insight, roles, loaded });
    }

    if (pathname === '/api/services/detail') {
      const label = url.searchParams.get('label');
      if (!label || !/^[A-Za-z0-9._-]{1,200}$/.test(label)) return sendJson(res, 400, { error: 'Invalid label' });
      const checks = await health.serviceChecks();
      const check = checks.find((service) => service.label === label) || null;
      const known = ((state.data && state.data.services && state.data.services.services) || []).find((service) => service.label === label) || null;
      const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
      return sendJson(res, 200, { label, check, known, plist: (await fs.stat(plist).catch(() => null)) ? plist : null });
    }

    if (pathname === '/api/ports/detail') {
      const port = Number(url.searchParams.get('port'));
      if (!Number.isInteger(port)) return sendJson(res, 400, { error: 'Invalid port' });
      const inv = state.data || {};
      const entry = (inv.ports || []).find((item) => item.port === port) || null;
      const service = (inv.services && inv.services.services ? inv.services.services : []).find((item) => item.pid && entry && item.pid === entry.pid) || null;
      let command = null;
      if (entry && entry.pid) {
        const result = await run('/bin/ps', ['-o', 'command=', '-p', String(entry.pid)], { timeout: 5000 });
        command = result.stdout.trim() || null;
      }
      return sendJson(res, 200, { port, entry, service, command });
    }

    if (pathname === '/api/overview') {
      return sendJson(res, 200, await cache.memo('overview', 0, async () => overview.report(state.data || {}, metrics.getModelUsage(), await notify.loadSettings())));
    }

    if (pathname === '/api/comfy/analysis') {
      return sendJson(res, 200, await cache.memo('comfy-analysis', 30_000, () => comfy.analysis(state.data || {})));
    }

    if (pathname === '/api/comfy/checkpoint') {
      const target = url.searchParams.get('path');
      if (!target) return sendJson(res, 400, { error: 'path is required' });
      return sendJson(res, 200, await comfy.checkpoint(state.data || {}, target));
    }

    if (pathname === '/api/packages/python/detail') {
      const name = url.searchParams.get('name');
      if (!name) return sendJson(res, 400, { error: 'name is required' });
      return sendJson(res, 200, await pkgMeta.pythonDetail(name, url.searchParams.get('label')));
    }

    if (pathname === '/api/packages/npm/detail') {
      const name = url.searchParams.get('name');
      if (!name) return sendJson(res, 400, { error: 'name is required' });
      return sendJson(res, 200, await pkgMeta.npmDetail(name));
    }

    if (pathname === '/api/packages/outdated') {
      return sendJson(res, 200, await cache.memo('pkg-outdated', 0, () => pkgMeta.outdated()));
    }

    if (pathname === '/api/file/detail') {
      const target = url.searchParams.get('path');
      if (!target) return sendJson(res, 400, { error: 'path is required' });
      return sendJson(res, 200, await files.detail(target));
    }

    if (pathname === '/api/disk/largest') {
      const target = url.searchParams.get('path') || os.homedir();
      const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 50));
      return sendJson(res, 200, await cache.memo(`largest:${target}:${limit}`, 60_000, () => disk.largestFiles(target, limit)));
    }

    if (pathname === '/api/brew/packages') {
      return sendJson(res, 200, await cache.memo('brew-packages', 0, () => brew.packages()));
    }

    if (pathname === '/api/brew/outdated') {
      const result = await run('/opt/homebrew/bin/brew', ['outdated', '--quiet'], { timeout: 90_000 });
      const outdated = result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
      return sendJson(res, 200, { outdated, available: result.ok });
    }

    if (pathname === '/api/hf/search') {
      return sendJson(res, 200, { models: await hf.search(url.searchParams.get('q')) });
    }

    if (pathname === '/api/hf/files') {
      const repo = url.searchParams.get('repo');
      if (!repo) return sendJson(res, 400, { error: 'repo is required' });
      return sendJson(res, 200, await hf.files(repo));
    }

    if (pathname === '/api/reclaim') {
      return sendJson(res, 200, await cache.memo('reclaim', 60_000, () => disk.reclaimReport()));
    }

    if (pathname === '/api/health/checks') {
      const [endpoints, services] = await Promise.all([health.endpointChecks(), health.serviceChecks()]);
      return sendJson(res, 200, { endpoints, services });
    }

    if (pathname === '/api/logs') {
      return sendJson(res, 200, { logs: await health.discoverLogs() });
    }

    if (pathname === '/api/logs/tail') {
      const target = url.searchParams.get('path');
      const lines = Number(url.searchParams.get('lines')) || 200;
      if (!target) return sendJson(res, 400, { error: 'path is required' });
      return sendJson(res, 200, await health.tailLog(target, lines));
    }

    if (pathname === '/api/security') {
      return sendJson(res, 200, await security.report());
    }

    if (pathname === '/api/network') {
      const [interfaces, routing, connections] = await Promise.all([network.interfaces(), network.routing(), network.connections()]);
      const sample = metrics.getLatest();
      return sendJson(res, 200, {
        interfaces,
        routing,
        connections,
        net: sample ? sample.net : null,
      });
    }

    if (pathname === '/api/network/ping') {
      return sendJson(res, 200, await network.ping(url.searchParams.get('host'), Number(url.searchParams.get('count')) || 3));
    }

    if (pathname === '/api/network/port') {
      return sendJson(res, 200, await network.portCheck(url.searchParams.get('host'), url.searchParams.get('port')));
    }

    if (pathname === '/api/agent') {
      return sendJson(res, 200, await agent.report());
    }

    if (pathname === '/api/gallery') {
      return sendJson(res, 200, { images: await gallery.listImages() });
    }

    if (pathname === '/api/device/image') {
      const model = url.searchParams.get('model') || '';
      try {
        const file = await device.deviceImage(model);
        if (!file) return sendJson(res, 404, { error: 'No device image' });
        const stat = await fs.stat(file);
        res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'image/png', 'Content-Length': stat.size, 'Cache-Control': 'public, max-age=3600' });
        fssync.createReadStream(file).pipe(res);
      } catch (error) {
        sendJson(res, error.status || 500, { error: error.message });
      }
      return;
    }

    if (pathname === '/api/symbols') {
      try {
        return sendJson(res, 200, { icons: Object.keys(await symbols.available()), version: await symbols.token(), masks: await symbols.masks() });
      } catch (error) {
        return sendJson(res, 200, { icons: [], version: '0', masks: {}, error: error.message });
      }
    }

    if (pathname === '/api/symbol/icon') {
      const id = url.searchParams.get('id') || '';
      const size = Math.max(12, Math.min(256, Number(url.searchParams.get('size')) || 64));
      try {
        const file = await symbols.icon(id, size);
        if (!file) return sendJson(res, 404, { error: 'No symbol' });
        const stat = await fs.stat(file);
        res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'image/png', 'Content-Length': stat.size, 'Cache-Control': 'no-store' });
        fssync.createReadStream(file).pipe(res);
      } catch (error) {
        sendJson(res, error.status || 500, { error: error.message });
      }
      return;
    }

    if (pathname === '/api/folder/icon') {
      const id = url.searchParams.get('id') || '';
      const size = Math.max(16, Math.min(128, Number(url.searchParams.get('size')) || 64));
      try {
        const file = await folders.folderIcon(id, size);
        if (!file) return sendJson(res, 404, { error: 'No folder icon' });
        const stat = await fs.stat(file);
        res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'image/png', 'Content-Length': stat.size, 'Cache-Control': 'public, max-age=86400' });
        fssync.createReadStream(file).pipe(res);
      } catch (error) {
        sendJson(res, error.status || 500, { error: error.message });
      }
      return;
    }

    if (pathname === '/api/file/icon') {
      const name = url.searchParams.get('name') || '';
      const size = Math.max(16, Math.min(128, Number(url.searchParams.get('size')) || 48));
      try {
        const file = await fileicons.fileIcon(name, size);
        if (!file) return sendJson(res, 404, { error: 'No file icon' });
        const stat = await fs.stat(file);
        res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'image/png', 'Content-Length': stat.size, 'Cache-Control': 'public, max-age=86400' });
        fssync.createReadStream(file).pipe(res);
      } catch (error) {
        sendJson(res, error.status || 500, { error: error.message });
      }
      return;
    }

    if (pathname === '/api/apps/icon') {
      const target = url.searchParams.get('path');
      if (!target) return sendJson(res, 400, { error: 'path is required' });
      const size = Math.max(16, Math.min(256, Number(url.searchParams.get('size')) || 128));
      try {
        const file = await icons.appIcon(target, size);
        if (!file) return sendJson(res, 404, { error: 'No icon available' });
        const stat = await fs.stat(file);
        res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'image/png', 'Content-Length': stat.size, 'Cache-Control': 'public, max-age=3600' });
        fssync.createReadStream(file).pipe(res);
      } catch (error) {
        sendJson(res, error.status || 500, { error: error.message });
      }
      return;
    }

    if (pathname === '/api/apps/detail') {
      const target = url.searchParams.get('path');
      if (!target) return sendJson(res, 400, { error: 'path is required' });
      return sendJson(res, 200, await apps.detail(target));
    }

    if (pathname === '/api/store/search') {
      const kind = url.searchParams.get('kind') === 'cask' ? 'cask' : 'formula';
      return sendJson(res, 200, { kind, results: await store.search(url.searchParams.get('q'), kind) });
    }

    if (pathname === '/api/store/info') {
      const kind = url.searchParams.get('kind') === 'cask' ? 'cask' : 'formula';
      const name = url.searchParams.get('name');
      if (!name) return sendJson(res, 400, { error: 'name is required' });
      return sendJson(res, 200, await store.info(name, kind));
    }

    if (pathname === '/api/store/featured') {
      return sendJson(res, 200, { apps: await store.featured() });
    }

    if (pathname === '/api/profile') {
      return sendJson(res, 200, await profile.report());
    }

    if (pathname === '/api/gallery/image') {
      const target = url.searchParams.get('path');
      if (!target) return sendJson(res, 400, { error: 'path is required' });
      const resolved = gallery.assertOutputPath(target);
      const stat = await fs.stat(resolved).catch(() => null);
      if (!stat || !stat.isFile()) return sendJson(res, 404, { error: 'not found' });
      const ext = path.extname(resolved).toLowerCase();
      const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime, 'Content-Length': stat.size, 'Cache-Control': 'max-age=120' });
      fssync.createReadStream(resolved).pipe(res);
      return;
    }

    if (pathname === '/api/comfy/queue') {
      return sendJson(res, 200, await gallery.queue());
    }

    if (pathname === '/api/comfy/interrupt' && req.method === 'POST') {
      if (READ_ONLY) return sendJson(res, 403, { error: 'Dashboard is in read-only mode' });
      if (!authorized(req)) return sendJson(res, 403, { error: 'Forbidden' });
      return sendJson(res, 200, await gallery.interrupt());
    }

    if (pathname === '/api/comfy/queue/clear' && req.method === 'POST') {
      if (READ_ONLY) return sendJson(res, 403, { error: 'Dashboard is in read-only mode' });
      if (!authorized(req)) return sendJson(res, 403, { error: 'Forbidden' });
      return sendJson(res, 200, await gallery.clearQueue());
    }

    if (pathname === '/api/notify' && req.method === 'GET') {
      return sendJson(res, 200, await notify.info());
    }

    if (pathname === '/api/notify' && req.method === 'POST') {
      if (!authorized(req)) return sendJson(res, 403, { error: 'Forbidden' });
      const body = await readBody(req);
      const settings = await notify.saveSettings(body || {});
      overview.clearCache();
      return sendJson(res, 200, { settings });
    }

    if (pathname === '/api/notify/test' && req.method === 'POST') {
      if (!authorized(req)) return sendJson(res, 403, { error: 'Forbidden' });
      const body = await readBody(req);
      return sendJson(res, 200, await notify.test(body && body.channel));
    }

    if (pathname.startsWith('/api/jobs/') && req.method === 'GET') {
      const id = pathname.slice('/api/jobs/'.length);
      const cursor = Number(url.searchParams.get('cursor') || 0) || 0;
      const job = getJob(id, cursor);
      if (!job) return sendJson(res, 404, { error: 'Job not found' });
      return sendJson(res, 200, job);
    }

    if (pathname === '/api/scan' && req.method === 'POST') {
      if (!authorized(req)) return sendJson(res, 403, { error: 'Forbidden' });
      const started = startScan();
      return sendJson(res, started ? 202 : 200, { scanning: state.scanning, started });
    }

    if (pathname === '/api/webauthn/status') {
      return sendJson(res, 200, await webauthn.status());
    }

    if (pathname === '/api/webauthn/register/options' && req.method === 'POST') {
      if (!authorized(req)) return sendJson(res, 403, { error: 'Forbidden' });
      return sendJson(res, 200, await webauthn.registrationOptions(req));
    }

    if (pathname === '/api/webauthn/register/verify' && req.method === 'POST') {
      if (!authorized(req)) return sendJson(res, 403, { error: 'Forbidden' });
      return sendJson(res, 200, await webauthn.verifyRegistration(await readBody(req)));
    }

    if (pathname === '/api/webauthn/auth/options' && req.method === 'POST') {
      if (!authorized(req)) return sendJson(res, 403, { error: 'Forbidden' });
      return sendJson(res, 200, await webauthn.authenticationOptions(req));
    }

    if (pathname === '/api/webauthn/auth/verify' && req.method === 'POST') {
      if (!authorized(req)) return sendJson(res, 403, { error: 'Forbidden' });
      return sendJson(res, 200, await webauthn.verifyAuthentication(await readBody(req)));
    }

    if (pathname === '/api/webauthn/native/register' && req.method === 'POST') {
      if (!authorized(req)) return sendJson(res, 403, { error: 'Forbidden' });
      return sendJson(res, 200, await webauthn.nativeRegister(await readBody(req)));
    }

    if (pathname === '/api/webauthn/native/options' && req.method === 'POST') {
      if (!authorized(req)) return sendJson(res, 403, { error: 'Forbidden' });
      return sendJson(res, 200, await webauthn.nativeOptions());
    }

    if (pathname === '/api/webauthn/native/verify' && req.method === 'POST') {
      if (!authorized(req)) return sendJson(res, 403, { error: 'Forbidden' });
      return sendJson(res, 200, await webauthn.nativeVerify(await readBody(req)));
    }

    if (pathname === '/api/webauthn/disable' && req.method === 'POST') {
      if (!authorized(req)) return sendJson(res, 403, { error: 'Forbidden' });
      const body = await readBody(req);
      if (await webauthn.isEnabled()) {
        const grant = body && body.webauthnGrant;
        if (!(await webauthn.verifyGrant(grant))) return sendJson(res, 403, { error: 'Touch ID verification required to disable' });
      }
      return sendJson(res, 200, await webauthn.disable());
    }

    if (pathname === '/api/push/status') {
      return sendJson(res, 200, await push.status());
    }

    if (pathname === '/api/push/subscribe' && req.method === 'POST') {
      if (!authorized(req)) return sendJson(res, 403, { error: 'Forbidden' });
      return sendJson(res, 200, await push.subscribe(await readBody(req)));
    }

    if (pathname === '/api/push/unsubscribe' && req.method === 'POST') {
      if (!authorized(req)) return sendJson(res, 403, { error: 'Forbidden' });
      const body = await readBody(req);
      return sendJson(res, 200, await push.unsubscribe(body.endpoint));
    }

    if (pathname === '/api/push/test' && req.method === 'POST') {
      if (!authorized(req)) return sendJson(res, 403, { error: 'Forbidden' });
      const results = await push.broadcast('Vantage test', `Push test at ${new Date().toLocaleTimeString()}`);
      return sendJson(res, 200, { ok: true, results });
    }

    if (pathname === '/api/upload' && req.method === 'POST') {
      if (READ_ONLY) return sendJson(res, 403, { error: 'Dashboard is in read-only mode' });
      if (!authorized(req)) return sendJson(res, 403, { error: 'Forbidden' });
      const body = await readBody(req, 64 * 1024 * 1024);
      if (!body || !body.name || typeof body.dataB64 !== 'string') return sendJson(res, 400, { error: 'name and dataB64 are required' });
      const bytes = Buffer.from(body.dataB64, 'base64');
      if (!bytes.length || bytes.length > 64 * 1024 * 1024) return sendJson(res, 400, { error: 'empty or oversized upload' });
      const safeName = path.basename(String(body.name)).replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'upload';
      const dir = path.join(DATA_DIR, 'uploads');
      await fs.mkdir(dir, { recursive: true });
      const target = path.join(dir, `${Date.now()}-${safeName}`);
      await fs.writeFile(target, bytes);
      const detail = await files.detail(target).catch(() => ({}));
      return sendJson(res, 200, { ok: true, path: target, name: safeName, size: bytes.length, detail });
    }

    if (pathname === '/api/update') {
      const status = await update.status();
      // Don't fire an update banner (and its first-run macOS permission prompt)
      // until setup is done.
      if (notifyWatcherStarted) notify.checkUpdate(status).catch(() => {});
      return sendJson(res, 200, status);
    }

    if (pathname === '/api/changelog') {
      return sendJson(res, 200, await changelog.report());
    }

    if (pathname === '/api/update/apply' && req.method === 'POST') {
      if (READ_ONLY) return sendJson(res, 403, { error: 'Dashboard is in read-only mode' });
      if (!authorized(req)) return sendJson(res, 403, { error: 'Forbidden' });
      return sendJson(res, 200, await update.apply());
    }

    if (pathname === '/api/setup') {
      return sendJson(res, 200, await setup.status());
    }

    if (pathname === '/api/setup/full-disk-access') {
      return sendJson(res, 200, { fullDiskAccess: await setup.fullDiskAccess() });
    }

    if (pathname === '/api/setup/folder-access' && req.method === 'POST') {
      if (READ_ONLY) return sendJson(res, 403, { error: 'Dashboard is in read-only mode' });
      if (!authorized(req)) return sendJson(res, 403, { error: 'Forbidden' });
      const body = await readBody(req);
      return sendJson(res, 200, await setup.requestFolderAccess(body && body.id));
    }

    if (pathname === '/api/installed' && req.method === 'POST') {
      if (!authorized(req)) return sendJson(res, 403, { error: 'Forbidden' });
      await settings.markPwaInstalled();
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/api/settings/data') {
      const uploadsDir = path.join(DATA_DIR, 'uploads');
      const uploads = { count: 0, bytes: 0 };
      try {
        const entries = await fs.readdir(uploadsDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          const st = await fs.stat(path.join(uploadsDir, entry.name)).catch(() => null);
          if (st) { uploads.count += 1; uploads.bytes += st.size; }
        }
      } catch { /* none */ }
      let samples = 0;
      let latest = null;
      try { samples = metrics.countSamples(); latest = (metrics.getLatest() || {}).ts || null; } catch { /* ignore */ }
      return sendJson(res, 200, { uploads, metrics: { samples, latest, intervalMs: metrics.intervalMs } });
    }

    if (pathname === '/api/settings') {
      if (req.method === 'PATCH') {
        if (READ_ONLY) return sendJson(res, 403, { error: 'Dashboard is in read-only mode' });
        if (!authorized(req)) return sendJson(res, 403, { error: 'Forbidden' });
        const body = await readBody(req);
        return sendJson(res, 200, await settings.patch(body.patch || body));
      }
      return sendJson(res, 200, {
        sections: settings.SECTIONS,
        registry: settings.REGISTRY,
        values: await settings.values(),
        capabilityState: {
          webauthn: await webauthn.status(),
          push: await push.status(),
          native: { built: native.exists() },
        },
        meta: { readOnly: READ_ONLY, prefsInitialized: settings.prefsInitialized() },
      });
    }

    if (pathname === '/api/settings/export' && req.method === 'POST') {
      if (!authorized(req)) return sendJson(res, 403, { error: 'Forbidden' });
      return sendJson(res, 200, await settings.exportAll());
    }

    if (pathname === '/api/settings/import' && req.method === 'POST') {
      if (READ_ONLY) return sendJson(res, 403, { error: 'Dashboard is in read-only mode' });
      if (!authorized(req)) return sendJson(res, 403, { error: 'Forbidden' });
      return sendJson(res, 200, { values: await settings.importAll(await readBody(req)) });
    }

    if (pathname === '/api/settings/reset' && req.method === 'POST') {
      if (READ_ONLY) return sendJson(res, 403, { error: 'Dashboard is in read-only mode' });
      if (!authorized(req)) return sendJson(res, 403, { error: 'Forbidden' });
      const body = await readBody(req);
      return sendJson(res, 200, { values: await settings.reset(body.section) });
    }

    if (pathname === '/api/onboarding') {
      if (req.method === 'POST' || req.method === 'PATCH') {
        if (READ_ONLY) return sendJson(res, 403, { error: 'Dashboard is in read-only mode' });
        if (!authorized(req)) return sendJson(res, 403, { error: 'Forbidden' });
        const before = await onboarding.get();
        const body = await readBody(req);
        const updated = await onboarding.update(body);
        if (!before.completedAt && updated.completedAt) afterOnboardingComplete();
        return sendJson(res, 200, updated);
      }
      if (req.method === 'DELETE') {
        if (!authorized(req)) return sendJson(res, 403, { error: 'Forbidden' });
        return sendJson(res, 200, await onboarding.reset());
      }
      return sendJson(res, 200, await onboarding.get());
    }

    if (pathname.startsWith('/api/actions/') && req.method === 'POST') {
      if (READ_ONLY) return sendJson(res, 403, { error: 'Dashboard is in read-only mode' });
      if (!authorized(req)) return sendJson(res, 403, { error: 'Forbidden' });
      const id = pathname.slice('/api/actions/'.length);
      const body = await readBody(req);
      const meta = getActionMeta(id);
      if (meta && meta.danger === 'high' && (await webauthn.isEnabled())) {
        const grant = body && body.webauthnGrant;
        if (!(await webauthn.verifyGrant(grant))) {
          return sendJson(res, 403, { error: 'Touch ID verification required for this action' });
        }
      }
      if (body && body.webauthnGrant) delete body.webauthnGrant;
      const result = await runAction(id, body || {});
      overview.clearCache();
      cache.clear();
      brew.clearCache();
      return sendJson(res, 200, result);
    }

    if (pathname.startsWith('/api/')) {
      return sendJson(res, 404, { error: 'unknown endpoint' });
    }

    return serveStatic(res, pathname);
  } catch (error) {
    const status = error && error.status ? error.status : 500;
    return sendJson(res, status, { error: error.message || 'Internal error' });
  }
});

server.listen(PORT, HOST, async () => {
  await loadCache();
  try {
    metrics.openStore(METRICS_DB);
    metrics.startSampler();
    setInterval(() => { metrics.pruneStore(); metrics.pruneHistory(); }, 60 * 60 * 1000).unref();
    console.log(`Metrics sampler started (${metrics.intervalMs / 1000}s, ${metrics.countSamples()} samples stored)`);
  } catch (error) {
    console.error('[metrics] failed to start sampler:', error.message);
  }

  async function buildDigest() {
    const sample = metrics.getLatest();
    const disk = (sample && sample.disk) || {};
    const parts = [];
    if (disk.total) parts.push(`${((disk.free / disk.total) * 100).toFixed(0)}% disk free (${(disk.free / 1024 ** 3).toFixed(0)} GB)`);
    const report = await overview.report(state.data || {}, metrics.getModelUsage(), await notify.loadSettings()).catch(() => null);
    if (report) {
      parts.push(`health ${report.health ? report.health.score : '–'}/100`);
      if (report.reclaimableBytes) parts.push(`${(report.reclaimableBytes / 1024 ** 3).toFixed(1)} GB reclaimable`);
      if (report.outdatedCount) parts.push(`${report.outdatedCount} outdated`);
      if (report.securityWarnings) parts.push(`${report.securityWarnings} security warning${report.securityWarnings === 1 ? '' : 's'}`);
    }
    return parts.join(' · ') || 'All quiet.';
  }

  // Threshold rules → notifications (+ optional action).
  setInterval(() => {
    rules
      .evaluate(metrics.getLatest(), {
        onTrigger: async (rule, value) => {
          const metric = rules.METRICS[rule.metric] || { label: rule.metric, unit: '' };
          if (notifyWatcherStarted) await notify.notify(`rule:${rule.id}`, 'Vantage alert', `${metric.label} is ${value.toFixed(1)}${metric.unit} (${rule.op} ${rule.threshold}${metric.unit})`, { force: true });
          if (rule.action) await runAction(rule.action, rule.params || {}).catch(() => {});
        },
      })
      .catch(() => {});
  }, 60_000).unref();

  // Scheduled actions & digests.
  setInterval(() => {
    schedule
      .runDue({
        onAction: (task) => runAction(task.action, task.params || {}),
        onDigest: async () => {
          const body = await buildDigest();
          if (notifyWatcherStarted) await notify.notify('schedule-digest', 'Vantage digest', body, { force: true });
        },
      })
      .catch(() => {});
  }, 60_000).unref();

  console.log(`Vantage running at http://${HOST}:${PORT}${READ_ONLY ? ' (read-only)' : ''}`);
  if (state.generatedAt) console.log(`Loaded cached inventory from ${state.generatedAt}`);

  // First run: don't walk into protected home folders or fire OS banners before
  // the wizard has had a chance to explain them. A quick scan fills the UI and a
  // full pass (plus the notification watcher) starts when onboarding completes.
  let setupComplete = true;
  try {
    const ob = await onboarding.get();
    setupComplete = Boolean(ob && ob.completedAt);
  } catch { /* treat as complete */ }

  if (setupComplete) startNotifyWatcher();

  // Warm the SF Symbols catalog in the background so the UI can switch to them
  // on first load (compiles the helper + renders once, then cached).
  symbols.available().catch(() => {});
  if (!state.data || cacheIsStale()) {
    const deep = setupComplete;
    console.log(deep ? 'Cache missing or stale, starting initial scan…' : 'First run, starting a quick scan before setup…');
    startScan({ deep });
  }
});

process.on('SIGINT', () => {
  console.log('\nShutting down.');
  metrics.stopSampler();
  notify.stopWatcher();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
});
