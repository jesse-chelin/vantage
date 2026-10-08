'use strict';

// Service endpoint probes, launchd health and log tailing.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');

const { run, listDir, statSafe } = require('./exec');

const HOME = os.homedir();
const UID = typeof process.getuid === 'function' ? process.getuid() : null;

const ENDPOINTS = [
  { id: 'ollama', label: 'Ollama', url: 'http://127.0.0.1:11434/api/tags', parse: (j) => (Array.isArray(j.models) ? `${j.models.length} models` : null) },
  { id: 'comfy', label: 'ComfyUI', url: 'http://127.0.0.1:8188/system_stats', parse: (j) => (j && j.system ? j.system.comfyui_version || null : null) },
  { id: 'gateway', label: 'OpenClaw gateway', url: 'http://127.0.0.1:18789/' },
  { id: 'miniapp', label: 'OpenClaw miniapp', url: 'http://127.0.0.1:8788/' },
  { id: 'dashboard', label: 'Dashboard', url: 'http://127.0.0.1:8790/api/health' },
];

const LOG_ROOTS = [
  path.join(HOME, '.openclaw', 'state'),
  '/tmp',
  '/opt/homebrew/var/log',
  path.join(HOME, 'Library', 'Logs', 'openclaw'),
  path.join(HOME, 'Library', 'Logs', 'Homebrew'),
];

async function probeEndpoint(endpoint) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(endpoint.url, { signal: controller.signal });
    const latencyMs = Date.now() - startedAt;
    let detail = null;
    if (endpoint.parse) {
      try {
        detail = endpoint.parse(await response.json());
      } catch {
        detail = null;
      }
    }
    let status;
    if (response.status >= 200 && response.status < 400) status = 'healthy';
    else if (response.status === 401 || response.status === 403) status = 'auth';
    else if (response.status >= 500) status = 'error';
    else status = 'reachable';
    return { id: endpoint.id, label: endpoint.label, url: endpoint.url, status, httpStatus: response.status, latencyMs, detail };
  } catch (error) {
    return {
      id: endpoint.id,
      label: endpoint.label,
      url: endpoint.url,
      status: 'down',
      httpStatus: null,
      latencyMs: null,
      error: error.name === 'AbortError' ? 'timed out' : error.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function endpointChecks() {
  return Promise.all(ENDPOINTS.map(probeEndpoint));
}

function pick(text, re) {
  const m = text.match(re);
  return m ? m[1] : null;
}

async function serviceChecks() {
  const list = await run('/bin/launchctl', ['list'], { timeout: 10_000 });
  const services = [];
  for (const line of list.stdout.split('\n').slice(1)) {
    const parts = line.split('\t');
    if (parts.length < 3 || !parts[2] || parts[2].startsWith('com.apple.')) continue;
    services.push({ label: parts[2], pid: parts[0] === '-' ? null : Number(parts[0]), status: Number(parts[1]) });
  }

  const enriched = [];
  for (const service of services.slice(0, 24)) {
    const info = await run('/bin/launchctl', ['print', `gui/${UID}/${service.label}`], { timeout: 8000 });
    const text = info.stdout;
    enriched.push({
      ...service,
      running: service.pid != null,
      runs: pick(text, /runs = (\d+)/) ? Number(pick(text, /runs = (\d+)/)) : null,
      lastExit: pick(text, /last exit code = (-?\d+)/),
      state: pick(text, /state = (\w+)/),
      stdout: pick(text, /stdout path = (.+)/),
    });
  }
  enriched.sort((a, b) => Number(b.running) - Number(a.running) || a.label.localeCompare(b.label));
  return enriched;
}

async function discoverLogs() {
  const seen = new Set();
  const logs = [];
  for (const root of LOG_ROOTS) {
    for (const entry of await listDir(root)) {
      if (!entry.isFile()) continue;
      if (!/\.(log|err|out)$/i.test(entry.name)) continue;
      const full = path.join(root, entry.name);
      if (seen.has(full)) continue;
      seen.add(full);
      const stat = await statSafe(full);
      if (stat) logs.push({ name: entry.name, path: full, bytes: stat.size, modifiedAt: stat.mtime.toISOString() });
    }
  }
  return logs.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
}

function isAllowedLogPath(target) {
  const resolved = path.resolve(target);
  return LOG_ROOTS.some((root) => {
    const base = path.resolve(root);
    return resolved === base || resolved.startsWith(base + path.sep);
  });
}

async function tailLog(target, lines = 200) {
  if (!isAllowedLogPath(target)) {
    const error = new Error('Log path is not allowed');
    error.status = 403;
    throw error;
  }
  const stat = await statSafe(target);
  if (!stat || !stat.isFile()) {
    const error = new Error('Log file not found');
    error.status = 404;
    throw error;
  }
  const windowBytes = 256 * 1024;
  const start = Math.max(0, stat.size - windowBytes);
  const handle = await fs.open(target, 'r');
  try {
    const buffer = Buffer.alloc(stat.size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const all = buffer.toString('utf8').split('\n');
    if (start > 0) all.shift(); // drop the partial first line
    const count = Math.max(1, Math.min(2000, Number(lines) || 200));
    return { path: target, bytes: stat.size, truncated: start > 0, lines: all.slice(-count) };
  } finally {
    await handle.close();
  }
}

module.exports = { endpointChecks, serviceChecks, discoverLogs, tailLog };
