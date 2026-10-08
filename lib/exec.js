'use strict';

// Small, dependency-free helpers for running commands and reading the disk.
// Everything here is best-effort: failures resolve with an error field rather
// than throwing, so one broken probe never takes down a whole scan.

const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;

function run(cmd, args = [], options = {}) {
  const {
    timeout = DEFAULT_TIMEOUT,
    cwd,
    maxBuffer = DEFAULT_MAX_BUFFER,
  } = options;

  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };

    let child;
    try {
      child = execFile(
        cmd,
        args,
        { timeout, cwd, maxBuffer, env: options.env ? { ...process.env, ...options.env } : process.env },
        (error, stdout, stderr) => {
          done({
            ok: !error,
            code: error && typeof error.code === 'number' ? error.code : error ? 1 : 0,
            stdout: stdout || '',
            stderr: stderr || '',
            error: error
              ? error.killed
                ? `timed out after ${timeout}ms`
                : error.message
              : null,
          });
        },
      );
    } catch (error) {
      done({ ok: false, code: 1, stdout: '', stderr: '', error: error.message });
      return;
    }

    // Swallow spawn errors (e.g. ENOENT), the callback above still fires,
    // but an unhandled 'error' listener would otherwise crash the process.
    if (child && typeof child.on === 'function') {
      child.on('error', () => {});
    }
  });
}

async function runJson(cmd, args = [], options = {}) {
  const result = await run(cmd, args, options);
  if (!result.ok || !result.stdout.trim()) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

async function fetchJson(url, timeout = 4_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function statSafe(target) {
  try {
    return await fs.stat(target);
  } catch {
    return null;
  }
}

async function readJsonSafe(target) {
  try {
    const raw = await fs.readFile(target, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function readTextSafe(target) {
  try {
    return await fs.readFile(target, 'utf8');
  } catch {
    return null;
  }
}

async function listDir(target) {
  try {
    return await fs.readdir(target, { withFileTypes: true });
  } catch {
    return [];
  }
}

// Parse `du -sk` output into a Map<path, bytes>.
function parseDu(stdout) {
  const sizes = new Map();
  for (const line of stdout.split('\n')) {
    const match = line.match(/^(\d+)\t(.+)$/);
    if (match) sizes.set(match[2], Number(match[1]) * 1024);
  }
  return sizes;
}

// Returns a Map<path, bytes> for the given paths using a single du invocation.
async function duPaths(paths, options = {}) {
  const unique = [...new Set(paths.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const result = await run('/usr/bin/du', ['-sk', ...unique], {
    timeout: options.timeout || 180_000,
  });
  return parseDu(result.stdout);
}

// Returns bytes for a single path (or null if it can't be measured).
async function duOne(target, options = {}) {
  const sizes = await duPaths([target], options);
  return sizes.get(target) ?? null;
}

// List children of a directory with their sizes, sorted largest first.
async function duChildren(dir, options = {}) {
  const entries = await listDir(dir);
  const paths = entries.map((entry) => `${dir}/${entry.name}`);
  const sizes = await duPaths(paths, options);
  return entries
    .map((entry) => ({
      name: entry.name,
      path: `${dir}/${entry.name}`,
      bytes: sizes.get(`${dir}/${entry.name}`) ?? null,
      isDirectory: entry.isDirectory(),
    }))
    .sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1));
}

module.exports = {
  run,
  runJson,
  fetchJson,
  exists,
  statSafe,
  readJsonSafe,
  readTextSafe,
  listDir,
  duPaths,
  duOne,
  duChildren,
};
