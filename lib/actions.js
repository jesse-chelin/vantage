'use strict';

// Management actions. Everything that mutates the machine lives here, behind
// strict validation and an allowlist, no arbitrary shell, no user-supplied
// command strings. Long-running actions run as background jobs with streamed
// output; quick actions run synchronously.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');

const { run, exists, listDir, fetchJson, statSafe, readJsonSafe, duOne } = require('./exec');
const { pruneOllamaOrphans, emptyTrash, discardPartials, trashOldOutputs, reclaimReport } = require('./disk');
const metrics = require('./metrics');
const maintenance = require('./maintenance');
const native = require('./native');
const { assertAppPath, leftovers } = require('./apps');
const { NAME_RE, clearCache: clearStoreCache } = require('./store');
const { pipOutdated, clearOutdatedCache } = require('./packages');

const HOME = os.homedir();
const UID = typeof process.getuid === 'function' ? process.getuid() : null;
const LAUNCH_AGENTS = path.join(HOME, 'Library', 'LaunchAgents');
const DATA_DIR = path.join(__dirname, '..', 'data');
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const MAX_JOBS = 40;
const MAX_OUTPUT_LINES = 4000;

// Roots from which files may be moved to the Trash. Anything outside these is
// rejected outright.
const TRASH_SAFE_ROOTS = [
  path.join(HOME, 'ComfyUI'),
  path.join(HOME, 'Downloads'),
  path.join(HOME, '.openclaw', 'backups'),
];
const BACKUP_FILE_RE = /^[\w.+-]+\.(tar\.gz|tgz|zip|tar|backup|bak)$/i;

// Emit a progress step for streaming actions. Best-effort: a closed stream, or a
// caller that passed no emitter (the default is a no-op), must never break work.
function emitStep(emit, id, label, status = 'active', detail = null) {
  try {
    emit({ type: 'step', id, label, status, detail: detail || null });
  } catch {
    /* ignore */
  }
}

function fmtBytesShort(bytes) {
  if (bytes == null) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(Math.max(1, bytes)) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// --- helpers ---------------------------------------------------------------

async function resolveBin(name) {
  for (const dir of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']) {
    const candidate = path.join(dir, name);
    if (await exists(candidate)) return candidate;
  }
  return name;
}

function assertModelName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 200) {
    throw new HttpError(400, 'Invalid model name');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*(:[A-Za-z0-9._-]+)?$/.test(name)) {
    throw new HttpError(400, 'Model name contains disallowed characters');
  }
  return name;
}

function assertServiceLabel(label) {
  if (typeof label !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(label)) {
    throw new HttpError(400, 'Invalid service label');
  }
  return label;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function ollamaTagNames() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const response = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return [];
    const data = await response.json();
    return (data.models || []).map((model) => model.name);
  } catch {
    return [];
  }
}

async function knownServiceLabels() {
  const labels = new Set();
  const result = await run('/bin/launchctl', ['list'], { timeout: 10_000 });
  for (const line of result.stdout.split('\n').slice(1)) {
    const parts = line.split('\t');
    if (parts.length >= 3 && parts[2] && !parts[2].startsWith('com.apple.')) labels.add(parts[2]);
  }
  for (const entry of await listDir(LAUNCH_AGENTS)) {
    if (entry.isFile() && entry.name.endsWith('.plist')) labels.add(entry.name.replace(/\.plist$/, ''));
  }
  return labels;
}

function resolveTrashTarget(inputPath) {
  if (typeof inputPath !== 'string' || !path.isAbsolute(inputPath)) {
    throw new HttpError(400, 'A safe absolute path is required');
  }
  const resolved = path.resolve(inputPath);
  const inSafeRoot = TRASH_SAFE_ROOTS.some(
    (root) => resolved === root || resolved.startsWith(root + path.sep),
  );
  const isHomeBackup = path.dirname(resolved) === HOME && BACKUP_FILE_RE.test(path.basename(resolved));
  if (!inSafeRoot && !isHomeBackup) {
    throw new HttpError(403, 'Refusing to trash a path outside the allowed locations');
  }
  return resolved;
}

async function moveToTrash(inputPath) {
  const resolved = resolveTrashTarget(inputPath);
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat) throw new HttpError(404, 'File not found');
  if (!stat.isFile()) throw new HttpError(400, 'Only files can be moved to the Trash');

  const trashDir = path.join(HOME, '.Trash');
  await fs.mkdir(trashDir, { recursive: true });
  let target = path.join(trashDir, path.basename(resolved));
  if (await exists(target)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    target = path.join(trashDir, `${path.basename(resolved)} ${stamp}`);
  }
  await fs.rename(resolved, target);
  return { message: `Moved to Trash: ${path.basename(resolved)}`, path: target };
}

async function moveToTrashAny(inputPath) {
  const resolved = resolveTrashTarget(inputPath);
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat) throw new HttpError(404, 'Not found');
  const trashDir = path.join(HOME, '.Trash');
  await fs.mkdir(trashDir, { recursive: true });
  let target = path.join(trashDir, path.basename(resolved));
  if (await exists(target)) target = path.join(trashDir, `${path.basename(resolved)} ${Date.now()}`);
  await fs.rename(resolved, target);
  return { message: `Moved ${path.basename(resolved)} to Trash`, path: target };
}

// --- job manager -----------------------------------------------------------

const jobs = new Map();

function splitLines(buffer) {
  return buffer.split(/\r\n|\r|\n/).filter((line) => line.length > 0);
}

function createJob(actionId, params, child) {
  const id = crypto.randomBytes(8).toString('hex');
  const job = {
    id,
    actionId,
    params,
    status: 'running',
    output: [],
    startedAt: new Date().toISOString(),
    endedAt: null,
    exitCode: null,
    error: null,
  };
  jobs.set(id, job);

  const push = (text) => {
    for (const line of splitLines(text)) {
      job.output.push(line);
    }
    if (job.output.length > MAX_OUTPUT_LINES) {
      job.output.splice(0, job.output.length - MAX_OUTPUT_LINES);
    }
  };

  child.stdout.on('data', (data) => push(data.toString()));
  child.stderr.on('data', (data) => push(data.toString()));
  child.on('error', (error) => {
    job.status = 'failed';
    job.error = error.message;
    job.endedAt = new Date().toISOString();
    if (job.historyId) metrics.updateActionStatus(job.historyId, 'failed', error.message);
  });
  child.on('close', (code) => {
    if (job.status === 'running') {
      job.status = code === 0 ? 'done' : 'failed';
      job.exitCode = code;
      job.endedAt = new Date().toISOString();
      if (code !== 0) job.error = `Exited with code ${code}`;
      if (job.historyId) metrics.updateActionStatus(job.historyId, job.status, job.error || null);
    }
  });

  pruneJobs();
  return job;
}

function pruneJobs() {
  const finished = [...jobs.values()].filter((item) => item.status !== 'running');
  if (finished.length > MAX_JOBS) {
    finished
      .sort((a, b) => new Date(a.endedAt) - new Date(b.endedAt))
      .slice(0, finished.length - MAX_JOBS)
      .forEach((item) => jobs.delete(item.id));
  }
}

// A job backed by an in-process async task (e.g. an HTTP benchmark) rather
// than a child process.
function createTaskJob(actionId, params, runner) {
  const id = crypto.randomBytes(8).toString('hex');
  const job = { id, actionId, params, status: 'running', output: [], startedAt: new Date().toISOString(), endedAt: null, exitCode: null, error: null };
  jobs.set(id, job);
  const push = (line) => {
    job.output.push(String(line));
    if (job.output.length > MAX_OUTPUT_LINES) job.output.splice(0, job.output.length - MAX_OUTPUT_LINES);
  };

  Promise.resolve()
    .then(() => runner({ log: push }))
    .then((result) => {
      job.status = 'done';
      job.exitCode = 0;
      if (result && result.message) push(result.message);
    })
    .catch((error) => {
      job.status = 'failed';
      job.error = error.message;
    })
    .finally(() => {
      job.endedAt = new Date().toISOString();
      if (job.historyId) metrics.updateActionStatus(job.historyId, job.status, job.error || null);
      pruneJobs();
    });

  return job;
}

function getJob(id, cursor = 0) {
  const job = jobs.get(id);
  if (!job) return null;
  const from = Math.max(0, Math.min(cursor, job.output.length));
  return {
    id: job.id,
    actionId: job.actionId,
    status: job.status,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    exitCode: job.exitCode,
    error: job.error,
    output: job.output.slice(from),
    cursor: job.output.length,
  };
}

function listJobs() {
  return [...jobs.values()]
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
    .map((job) => ({
      id: job.id,
      actionId: job.actionId,
      status: job.status,
      startedAt: job.startedAt,
      endedAt: job.endedAt,
    }));
}

function spawnJob(actionId, params, bin, args, options = {}) {
  const child = spawn(bin, args, { env: options.env ? { ...process.env, ...options.env } : process.env, cwd: options.cwd });
  return createJob(actionId, params, child);
}

// --- action handlers -------------------------------------------------------

async function actionOllamaPull(params) {
  const model = assertModelName(params.model);
  const bin = await resolveBin('ollama');
  return { job: spawnJob('ollama.pull', { model }, bin, ['pull', model]) };
}

async function actionOllamaRemove(params) {
  const model = assertModelName(params.model);
  const names = await ollamaTagNames();
  if (!names.includes(model)) {
    throw new HttpError(404, `Model "${model}" is not installed`);
  }
  const bin = await resolveBin('ollama');
  return { job: spawnJob('ollama.remove', { model }, bin, ['rm', model]) };
}

async function actionOllamaRemoveMany(params) {
  const list = Array.isArray(params.models) ? params.models : [];
  if (!list.length) throw new HttpError(400, 'No models specified');
  const names = await ollamaTagNames();
  const valid = list.filter((name) => names.includes(name)).map(assertModelName);
  if (!valid.length) throw new HttpError(404, 'No matching installed models');
  const bin = await resolveBin('ollama');
  return { job: spawnJob('ollama.removeMany', { count: valid.length }, bin, ['rm', ...valid]) };
}

async function ollamaModelInfo(model) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const response = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return null;
    const data = await response.json();
    return (data.models || []).find((item) => item.name === model) || null;
  } catch {
    return null;
  }
}

function keepAliveBody(model, info, keepAlive) {
  const caps = (info && info.capabilities) || [];
  const embeddingOnly = caps.includes('embedding') && !caps.includes('completion');
  if (embeddingOnly) {
    return { url: `${OLLAMA_HOST}/api/embed`, body: { model, input: 'warmup', keep_alive: keepAlive } };
  }
  return { url: `${OLLAMA_HOST}/api/generate`, body: { model, prompt: '', keep_alive: keepAlive, stream: false } };
}

async function actionOllamaUnload(params) {
  const model = assertModelName(params.model);
  const info = await ollamaModelInfo(model);
  const { url, body } = keepAliveBody(model, info, 0);
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new HttpError(502, `Ollama returned ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
  }
  return { message: `Unloaded ${model} from memory` };
}

async function actionOllamaLoad(params) {
  const model = assertModelName(params.model);
  const keepAlive = typeof params.keepAlive === 'string' && /^[0-9a-z]+$/.test(params.keepAlive) ? params.keepAlive : '30m';
  const info = await ollamaModelInfo(model);
  const { url, body } = keepAliveBody(model, info, keepAlive);
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new HttpError(502, `Ollama returned ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
  }
  return { message: `Loaded ${model} (keep-alive ${keepAlive})` };
}

async function serviceAction(op, params, emit = () => {}) {
  const label = assertServiceLabel(params.label);
  const labels = await knownServiceLabels();
  if (!labels.has(label)) throw new HttpError(403, `Unknown service label "${label}"`);

  const target = `gui/${UID}/${label}`;
  const launchctl = '/bin/launchctl';

  if (op === 'restart') {
    emitStep(emit, 'restart', `Restarting ${label}`, 'active');
    const result = await run(launchctl, ['kickstart', '-k', target], { timeout: 20_000 });
    if (!result.ok) throw new HttpError(500, result.stderr.trim() || result.error || 'kickstart failed');
    emitStep(emit, 'restart', `${label} restarted`, 'done');
    return { message: `Restarted ${label}` };
  }

  if (op === 'stop') {
    emitStep(emit, 'stop', `Stopping ${label}`, 'active');
    const result = await run(launchctl, ['bootout', target], { timeout: 20_000 });
    if (!result.ok && !/no such process|not find/i.test(result.stderr)) {
      throw new HttpError(500, result.stderr.trim() || result.error || 'bootout failed');
    }
    emitStep(emit, 'stop', `${label} stopped`, 'done');
    return { message: `Stopped ${label}` };
  }

  // start
  const plist = path.join(LAUNCH_AGENTS, `${label}.plist`);
  if (await exists(plist)) {
    emitStep(emit, 'load', `Loading ${label}`, 'active');
    await run(launchctl, ['bootstrap', `gui/${UID}`, plist], { timeout: 20_000 });
    emitStep(emit, 'load', `${label} loaded`, 'done');
  }
  emitStep(emit, 'start', `Starting ${label}`, 'active');
  const result = await run(launchctl, ['kickstart', '-k', target], { timeout: 20_000 });
  if (!result.ok) throw new HttpError(500, result.stderr.trim() || result.error || 'kickstart failed');
  emitStep(emit, 'start', `${label} started`, 'done');
  return { message: `Started ${label}` };
}

async function actionFileTrash(params, emit = () => {}) {
  emitStep(emit, 'move', `Moving ${path.basename(String(params.path || ''))} to the Trash`, 'active');
  const result = await moveToTrash(params.path);
  emitStep(emit, 'move', `${path.basename(String(params.path || ''))} moved to the Trash`, 'done');
  return { message: result.message, undoMoves: [{ from: result.path, to: path.resolve(String(params.path)) }] };
}

async function actionFileReveal(params) {
  const input = typeof params.path === 'string' && params.path.startsWith('~/') ? path.join(HOME, params.path.slice(2)) : params.path;
  if (typeof input !== 'string' || !path.isAbsolute(input)) {
    throw new HttpError(400, 'A safe absolute path is required');
  }
  const resolved = path.resolve(input);
  const allowed = [HOME, '/Applications', '/System/Applications'];
  if (!allowed.some((root) => resolved === root || resolved.startsWith(root + path.sep))) {
    throw new HttpError(403, 'Path is outside the allowed locations');
  }
  if (!(await exists(resolved))) throw new HttpError(404, 'File not found');
  const result = await run('/usr/bin/open', ['-R', resolved], { timeout: 10_000 });
  if (!result.ok) throw new HttpError(500, result.error || 'Could not open Finder');
  return { message: 'Revealed in Finder' };
}

async function actionAppOpen(params, emit = () => {}) {
  const appPath = assertAppPath(params.path);
  const name = path.basename(appPath, '.app');
  emitStep(emit, 'open', `Opening ${name}`, 'active');
  const result = await run('/usr/bin/open', [appPath], { timeout: 10_000 });
  if (!result.ok) throw new HttpError(500, result.stderr.trim() || result.error || 'Could not open application');
  emitStep(emit, 'open', `${name} opened`, 'done');
  return { message: `Opened ${name}` };
}

async function actionAppQuit(params, emit = () => {}) {
  const name = String(params.name || '');
  if (!/^[\w .&+-]{1,80}$/.test(name)) throw new HttpError(400, 'Invalid application name');
  emitStep(emit, 'quit', `Asking ${name} to quit`, 'active');
  const result = await run('/usr/bin/osascript', ['-e', `tell application ${JSON.stringify(name)} to quit`], { timeout: 10_000 });
  if (!result.ok) throw new HttpError(500, result.stderr.trim() || 'Could not quit application');
  emitStep(emit, 'quit', `${name} asked to quit`, 'done');
  return { message: `Asked ${name} to quit` };
}

// Move a path into ~/.Trash with a plain rename, returning the destination.
async function renameIntoTrash(target) {
  const trashDir = path.join(HOME, '.Trash');
  await fs.mkdir(trashDir, { recursive: true });
  let destination = path.join(trashDir, path.basename(target));
  if (await exists(destination)) destination = path.join(trashDir, `${path.basename(target)} ${Date.now()}`);
  await fs.rename(target, destination);
  return destination;
}

// macOS App Management refuses a plain rename for bundles this process did not
// create (most App Store apps). Finder is allowed to move them, so hand the
// batch to it in one call — one admin prompt covers every app.
async function finderDelete(paths) {
  const moved = {};
  if (!paths.length) return moved;
  const list = paths.map((target) => `POSIX file ${JSON.stringify(target)}`).join(', ');
  const result = await run('/usr/bin/osascript', ['-e', `tell application "Finder" to delete {${list}}`], { timeout: 60_000 });
  if (!result.ok) return moved;
  const trashDir = path.join(HOME, '.Trash');
  const entries = await listDir(trashDir);
  for (const target of paths) {
    if (await exists(target)) continue;
    const base = path.basename(target);
    const entry = entries.find((item) => item.name === base || item.name.startsWith(`${base} `));
    moved[target] = entry ? path.join(trashDir, entry.name) : path.join(trashDir, base);
  }
  return moved;
}

function assertAppPaths(list) {
  const paths = Array.isArray(list) ? list : [];
  if (!paths.length) throw new HttpError(400, 'No applications selected');
  return [...new Set(paths.map((target) => assertAppPath(target)))].slice(0, 100);
}

// Move a single app bundle, authorising via Finder when macOS refuses.
async function moveOneAppToTrash(appPath, name) {
  try {
    return { destination: await renameIntoTrash(appPath), refused: false };
  } catch (error) {
    if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
  }
  const moved = await finderDelete([appPath]);
  if (!moved[appPath]) {
    throw new HttpError(
      500,
      `macOS blocked Vantage from moving ${name} to the Trash. Grant Vantage “App Management” in System Settings → Privacy & Security → App Management, or drag the app to the Trash in Finder.`,
    );
  }
  return { destination: moved[appPath], refused: true };
}

async function actionAppTrash(params, emit = () => {}) {
  const appPath = assertAppPath(params.path);
  const stat = await statSafe(appPath);
  if (!stat || !stat.isDirectory()) throw new HttpError(404, 'Application not found');
  const name = path.basename(appPath, '.app');
  const bytes = (await duOne(appPath, { timeout: 60_000 })) || 0;
  emitStep(emit, 'move', `Moving ${name} to the Trash`, 'active');
  const { destination } = await moveOneAppToTrash(appPath, name);
  emitStep(emit, 'move', `${name} moved to the Trash`, 'done', fmtBytesShort(bytes));
  return { message: `Moved ${name} to Trash`, undoMoves: [{ from: destination, to: appPath }] };
}

async function actionAppsTrash(params, emit = () => {}) {
  const apps = assertAppPaths(params.paths);
  const sizes = new Map();
  for (const appPath of apps) sizes.set(appPath, (await duOne(appPath, { timeout: 60_000 })) || 0);

  const undoMoves = [];
  const skipped = [];
  const refused = [];
  let bytes = 0;
  for (const appPath of apps) {
    const name = path.basename(appPath, '.app');
    emitStep(emit, `${appPath}:move`, `Moving ${name} to the Trash`, 'active');
    try {
      const destination = await renameIntoTrash(appPath);
      undoMoves.push({ from: destination, to: appPath });
      bytes += sizes.get(appPath) || 0;
      emitStep(emit, `${appPath}:move`, `${name} moved to the Trash`, 'done', fmtBytesShort(sizes.get(appPath)));
    } catch (error) {
      if (['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) {
        refused.push({ appPath, name, bytes: sizes.get(appPath) || 0 });
        emitStep(emit, `${appPath}:move`, `Waiting for macOS to authorise moving ${name}`, 'active');
      } else {
        skipped.push(appPath);
        emitStep(emit, `${appPath}:move`, `${name}: ${error.message}`, 'failed');
      }
    }
  }

  if (refused.length) {
    const auth = await authoriseRefusedApps(refused, emit, undoMoves);
    bytes += auth.bytes;
    skipped.push(...auth.skipped);
  }
  const moved = apps.length - skipped.length;
  return { message: `Moved ${moved} app${moved === 1 ? '' : 's'} to Trash${skipped.length ? ` (${skipped.length} skipped)` : ''}`, bytes, undoMoves, skipped };
}

// Move a path into the Trash without the file-only / safe-root restrictions,
// returning the Trash location so the move can be undone from History.
async function trashAnywhere(target) {
  const trashDir = path.join(HOME, '.Trash');
  await fs.mkdir(trashDir, { recursive: true });
  let destination = path.join(trashDir, path.basename(target));
  if (await exists(destination)) destination = path.join(trashDir, `${path.basename(target)} ${Date.now()}`);
  await fs.rename(target, destination);
  return destination;
}

// "Remove completely": the app bundle plus the user-level leftovers it leaves in
// ~/Library (caches, preferences, containers, logs, launch agents). Everything
// goes to the Trash, so nothing here is permanent.
// Scan + quit + move one app bundle and its leftovers, emitting live steps.
// Returns a plan; App-Management refusals are collected so a batch can be
// authorised with a single Finder call.
async function trashAppAndLeftovers(appPath, emit, key) {
  const folderName = path.basename(appPath, '.app');
  const result = { appPath, name: folderName, appBytes: 0, undoMoves: [], skipped: [], removedLeftovers: 0, bytes: 0, refused: false };

  emitStep(emit, `${key}:scan`, `Looking for files ${folderName} left behind`, 'active');
  let report = { app: {}, items: [], totalBytes: 0 };
  try {
    report = await leftovers(appPath);
  } catch {
    /* not fatal: remove the bundle even if the scan fails */
  }
  result.appBytes = (await duOne(appPath, { timeout: 60_000 })) || 0;
  result.name = (report.app && report.app.name) || folderName;
  emitStep(
    emit,
    `${key}:scan`,
    report.items.length ? `Found ${report.items.length} leftover item${report.items.length === 1 ? '' : 's'}` : 'No leftover files found',
    'done',
    report.items.length ? fmtBytesShort(report.totalBytes) : null,
  );

  // Quit only if it is actually running, so we never launch the app to quit it.
  if (/^[\w .&+-]{1,80}$/.test(result.name)) {
    const running = (await run('/usr/bin/pgrep', ['-x', result.name], { timeout: 4000 })).ok;
    if (running) {
      emitStep(emit, `${key}:quit`, `Asking ${result.name} to quit`, 'active');
      await run('/usr/bin/osascript', ['-e', `tell application ${JSON.stringify(result.name)} to quit`], { timeout: 8000 }).catch(() => {});
      emitStep(emit, `${key}:quit`, `${result.name} closed`, 'done');
    } else {
      emitStep(emit, `${key}:quit`, `${result.name} isn't running`, 'skip');
    }
  }

  // Move the bundle first: if macOS refuses, nothing else has been touched.
  emitStep(emit, `${key}:move`, `Moving ${result.name} to the Trash`, 'active');
  try {
    const destination = await renameIntoTrash(appPath);
    result.undoMoves.push({ from: destination, to: appPath });
    result.bytes += result.appBytes;
    emitStep(emit, `${key}:move`, `${result.name} moved to the Trash`, 'done', fmtBytesShort(result.appBytes));
  } catch (error) {
    if (['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) {
      result.refused = true;
      emitStep(emit, `${key}:move`, `Waiting for macOS to authorise moving ${result.name}`, 'active');
    } else {
      result.skipped.push(appPath);
      emitStep(emit, `${key}:move`, `${result.name}: ${error.message}`, 'failed');
    }
  }

  if (report.items.length) {
    emitStep(emit, `${key}:leftovers`, `Cleaning up ${report.items.length} leftover item${report.items.length === 1 ? '' : 's'}`, 'active');
    let done = 0;
    let leftoverBytes = 0;
    for (const item of report.items) {
      try {
        const destination = await trashAnywhere(item.path);
        result.undoMoves.push({ from: destination, to: item.path });
        done += 1;
        leftoverBytes += item.bytes || 0;
      } catch {
        result.skipped.push(item.path);
      }
    }
    result.removedLeftovers = done;
    result.bytes += leftoverBytes;
    emitStep(emit, `${key}:leftovers`, `Removed ${done} leftover item${done === 1 ? '' : 's'}`, 'done', fmtBytesShort(leftoverBytes));
  }
  return result;
}

// Authorise the bundles macOS refused (App Store apps) with one batched Finder
// call, so a bulk removal only costs the user a single authorisation.
async function authoriseRefusedApps(refused, emit, undoMoves) {
  if (!refused.length) return { moved: 0, bytes: 0, skipped: [] };
  emitStep(emit, 'authorize', `Asking macOS to authorise ${refused.length} app${refused.length === 1 ? '' : 's'}`, 'active');
  const moved = await finderDelete(refused.map((item) => item.appPath));
  let count = 0;
  let bytes = 0;
  const skipped = [];
  for (const item of refused) {
    const destination = moved[item.appPath];
    if (destination) {
      undoMoves.push({ from: destination, to: item.appPath });
      count += 1;
      bytes += item.appBytes || 0;
      emitStep(emit, `${item.appPath}:move`, `${item.name} moved to the Trash`, 'done', fmtBytesShort(item.appBytes));
    } else {
      skipped.push(item.appPath);
      emitStep(emit, `${item.appPath}:move`, `${item.name} could not be moved`, 'failed');
    }
  }
  emitStep(emit, 'authorize', 'Authorisation complete', 'done');
  return { moved: count, bytes, skipped };
}

// "Remove completely": the app bundle plus the user-level leftovers it leaves in
// ~/Library (caches, preferences, containers, logs, launch agents). Everything
// goes to the Trash, so nothing here is permanent.
async function actionAppRemove(params, emit = () => {}) {
  const appPath = assertAppPath(params.path);
  const stat = await statSafe(appPath);
  if (!stat || !stat.isDirectory()) throw new HttpError(404, 'Application not found');
  const result = await trashAppAndLeftovers(appPath, emit, 'app');
  if (result.refused) {
    const auth = await authoriseRefusedApps([result], emit, result.undoMoves);
    result.bytes += auth.bytes;
    result.skipped.push(...auth.skipped);
  }
  const parts = [`Moved ${result.name} to Trash`];
  if (result.removedLeftovers) parts.push(`${result.removedLeftovers} leftover item${result.removedLeftovers === 1 ? '' : 's'}`);
  const message = `${parts.join(' and ')}${result.skipped.length ? ` (${result.skipped.length} could not be moved)` : ''}`;
  return { message, bytes: result.bytes, undoMoves: result.undoMoves, skipped: result.skipped };
}

async function actionAppsRemove(params, emit = () => {}) {
  const apps = assertAppPaths(params.paths);
  const refused = [];
  const undoMoves = [];
  const skipped = [];
  let removedApps = 0;
  let removedLeftovers = 0;
  let bytes = 0;

  for (const appPath of apps) {
    const result = await trashAppAndLeftovers(appPath, emit, appPath);
    undoMoves.push(...result.undoMoves);
    skipped.push(...result.skipped);
    removedLeftovers += result.removedLeftovers;
    bytes += result.bytes;
    if (result.refused) refused.push(result);
    else removedApps += 1;
  }

  if (refused.length) {
    const auth = await authoriseRefusedApps(refused, emit, undoMoves);
    removedApps += auth.moved;
    bytes += auth.bytes;
    skipped.push(...auth.skipped);
  }

  const message = `Removed ${removedApps} app${removedApps === 1 ? '' : 's'}${removedLeftovers ? ` and ${removedLeftovers} leftover item${removedLeftovers === 1 ? '' : 's'}` : ''}${skipped.length ? ` (${skipped.length} skipped)` : ''}`;
  return { message, bytes, undoMoves, skipped };
}

function assertBrewName(name) {
  const value = String(name || '');
  if (!NAME_RE.test(value)) throw new HttpError(400, 'Invalid package name');
  return value;
}

function brewKind(params) {
  return params && params.kind === 'cask' ? 'cask' : 'formula';
}

async function actionBrewInstall(params) {
  const name = assertBrewName(params.name);
  const kind = brewKind(params);
  clearStoreCache();
  const bin = await resolveBin('brew');
  return { job: spawnJob('brew.install', { name, kind }, bin, ['install', ...(kind === 'cask' ? ['--cask'] : []), name]) };
}

async function actionBrewUninstall(params) {
  const name = assertBrewName(params.name);
  const kind = brewKind(params);
  clearStoreCache();
  const bin = await resolveBin('brew');
  return { job: spawnJob('brew.uninstall', { name, kind }, bin, ['uninstall', ...(kind === 'cask' ? ['--cask'] : []), name]) };
}

async function actionBrewUpgrade(params) {
  const name = assertBrewName(params.name);
  clearStoreCache();
  const bin = await resolveBin('brew');
  return { job: spawnJob('brew.upgrade', { name }, bin, ['upgrade', name]) };
}

async function actionBrewUpgradeAll() {
  clearStoreCache();
  const bin = await resolveBin('brew');
  return { job: spawnJob('brew.upgradeAll', {}, bin, ['upgrade']) };
}

const PY_BINS = { '3.14': '/opt/homebrew/bin/python3.14', '3.12': '/opt/homebrew/bin/python3.12' };

async function actionPipUpgrade(params) {
  const name = String(params.name || '');
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(name)) throw new HttpError(400, 'Invalid package name');
  const bin = PY_BINS[params.label] || PY_BINS['3.14'];
  if (!(await exists(bin))) throw new HttpError(404, 'Python interpreter not found');
  return {
    job: spawnJob('pip.upgrade', { name }, bin, ['-m', 'pip', 'install', '--upgrade', name], {
      env: { PIP_BREAK_SYSTEM_PACKAGES: '1' },
    }),
  };
}

async function actionNpmUpdate(params) {
  const name = String(params.name || '');
  if (!/^(@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]{1,214}$/.test(name)) throw new HttpError(400, 'Invalid package name');
  const bin = await resolveBin('npm');
  return { job: spawnJob('npm.update', { name }, bin, ['install', '-g', `${name}@latest`]) };
}

async function actionPipUpgradeAll(params) {
  const label = params.label === '3.12' ? '3.12' : '3.14';
  const bin = PY_BINS[label];
  if (!(await exists(bin))) throw new HttpError(404, 'Python interpreter not found');
  const result = await pipOutdated(label);
  if (!result.available) throw new HttpError(502, result.error || 'Could not check for outdated packages');
  const names = result.packages.map((pkg) => pkg.name).filter((name) => /^[A-Za-z0-9._-]{1,200}$/.test(name));
  if (!names.length) return { message: `Python ${label} packages are all up to date` };
  clearOutdatedCache();
  return {
    job: spawnJob('pip.upgradeAll', { count: names.length, label }, bin, ['-m', 'pip', 'install', '--upgrade', ...names], {
      env: { PIP_BREAK_SYSTEM_PACKAGES: '1' },
    }),
  };
}

async function actionNpmUpdateAll() {
  clearOutdatedCache();
  const bin = await resolveBin('npm');
  return { job: spawnJob('npm.updateAll', {}, bin, ['update', '-g']) };
}

async function actionNpmUninstall(params) {
  const name = String(params.name || '');
  if (!/^(@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]{1,214}$/.test(name)) throw new HttpError(400, 'Invalid package name');
  const bin = await resolveBin('npm');
  return { job: spawnJob('npm.uninstall', { name }, bin, ['uninstall', '-g', name]) };
}

async function actionDownloadsClear(emit = () => {}) {
  const dir = path.join(HOME, 'Downloads');
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    emitStep(emit, 'clear', 'Downloads is already empty', 'skip');
    return { message: 'Downloads is already empty' };
  }
  const items = entries.filter((entry) => entry.name !== '.localized' && entry.name !== '.DS_Store');
  if (!items.length) {
    emitStep(emit, 'clear', 'Downloads is already empty', 'skip');
    return { message: 'Downloads is already empty' };
  }
  emitStep(emit, 'clear', `Clearing ${items.length} item${items.length === 1 ? '' : 's'} from Downloads`, 'active');
  let moved = 0;
  for (const entry of items) {
    try {
      await moveToTrashAny(path.join(dir, entry.name));
      moved += 1;
    } catch {
      /* skip locked items */
    }
  }
  emitStep(emit, 'clear', moved ? `Moved ${moved} item${moved === 1 ? '' : 's'} to the Trash` : 'Nothing could be moved', moved ? 'done' : 'failed');
  return { message: moved ? `Moved ${moved} item${moved === 1 ? '' : 's'} from Downloads to Trash` : 'Downloads is already empty' };
}

const CACHE_TARGETS = {
  npm: { label: 'npm cache', bin: 'npm', args: ['cache', 'clean', '--force'] },
  pip: { label: 'pip cache', bin: '/opt/homebrew/bin/python3.14', args: ['-m', 'pip', 'cache', 'purge'] },
  brew: { label: 'Homebrew cache', bin: '/opt/homebrew/bin/brew', args: ['cleanup', '-s'] },
};

async function actionCachePrune(params) {
  const target = CACHE_TARGETS[params.target];
  if (!target) throw new HttpError(400, 'Unknown cache target');
  const bin = await resolveBin(target.bin);
  return { job: spawnJob('cache.prune', { target: params.target }, bin, target.args) };
}

const CLEAN_ITEMS = ['ollama-orphans', 'trash', 'partials', 'old-outputs', 'brew-cache', 'npm-cache', 'pip-cache'];

function fmtGB(bytes) {
  return `${(Number(bytes || 0) / 1024 ** 3).toFixed(2)} GB`;
}

// One-click "clean up everything safe": empties the Trash, prunes caches and
// orphaned blobs, and discards partial/stale files, reporting a before/after.
async function actionSystemCleanAll(params, emit = () => {}) {
  const wanted = Array.isArray(params.items) && params.items.length ? new Set(params.items) : new Set(CLEAN_ITEMS);

  emitStep(emit, 'scan', 'Scanning reclaimable space', 'active');
  const report = await reclaimReport().catch(() => ({ items: [], partials: [] }));
  let estimated = 0;
  for (const item of report.items || []) if (wanted.has(item.id)) estimated += item.bytes || 0;
  if (wanted.has('partials')) estimated += (report.partials || []).reduce((sum, p) => sum + (p.bytes || 0), 0);
  emitStep(emit, 'scan', 'Scanned reclaimable space', 'done', estimated ? `up to ${fmtGB(estimated)}` : null);

  const step = async (id, active, done, fn) => {
    if (!wanted.has(id)) return;
    emitStep(emit, id, active, 'active');
    try {
      const result = await fn();
      emitStep(emit, id, (result && result.message) || done, 'done');
    } catch (error) {
      emitStep(emit, id, `${done}: ${error.message}`, 'failed');
    }
  };

  await step('ollama-orphans', 'Pruning orphaned Ollama blobs', 'Pruned orphaned Ollama blobs', () => pruneOllamaOrphans());
  await step('trash', 'Emptying the Trash', 'Emptied the Trash', () => emptyTrash());
  await step('partials', 'Discarding partial downloads', 'Discarded partial downloads', () => discardPartials());
  await step('old-outputs', 'Trashing old ComfyUI outputs', 'Trashed old ComfyUI outputs', () => trashOldOutputs(30));
  for (const [id, target] of [['brew-cache', 'brew'], ['npm-cache', 'npm'], ['pip-cache', 'pip']]) {
    if (!wanted.has(id)) continue;
    const config = CACHE_TARGETS[target];
    emitStep(emit, id, `Clearing the ${config.label}`, 'active');
    try {
      const bin = await resolveBin(config.bin);
      const result = await run(bin, config.args, { timeout: 180_000 });
      emitStep(emit, id, result.ok ? `Cleared the ${config.label}` : `${config.label}: ${(result.stderr || '').trim().slice(0, 140) || 'failed'}`, result.ok ? 'done' : 'failed');
    } catch (error) {
      emitStep(emit, id, `${config.label}: ${error.message}`, 'failed');
    }
  }

  const message = estimated > 0 ? `Cleanup complete · reclaimed up to ${fmtGB(estimated)}` : 'Cleanup complete';
  return { message, bytes: estimated };
}

async function actionBrewCleanup() {
  const bin = await resolveBin('brew');
  const result = await run(bin, ['cleanup', '-s'], { timeout: 180_000 });
  if (!result.ok) throw new HttpError(500, result.stderr.trim() || result.error || 'brew cleanup failed');
  return { message: 'Homebrew cleanup complete', output: result.stdout.trim() };
}

// --- one-click maintenance -------------------------------------------------

async function actionMaintenanceCaffeinate(params) {
  return maintenance.setCaffeinate(Boolean(params.on));
}
async function actionMaintenanceOllamaProfile(params, emit = () => {}) {
  const profile = String(params.profile || 'balanced');
  emitStep(emit, 'profile', `Applying the ${profile} Ollama profile`, 'active');
  const result = await maintenance.setOllamaProfile(profile);
  emitStep(emit, 'profile', (result && result.message) || 'Profile applied', 'done');
  return result;
}
async function actionMaintenanceLoginItem(params) {
  return maintenance.setLoginItem(params.name, Boolean(params.enabled));
}
async function actionMaintenanceBackupNow(emit = () => {}) {
  emitStep(emit, 'backup', 'Starting a Time Machine backup', 'active');
  const result = await maintenance.backupNow();
  emitStep(emit, 'backup', (result && result.message) || 'Backup started', 'done');
  return result;
}

async function actionNativeLaunch() {
  return {
    job: createTaskJob('native.launch', {}, async ({ log }) => {
      if (!native.exists()) {
        log('Building the native app (first time, a few seconds)…');
        await native.build();
        log('Built.');
      }
      return native.launch();
    }),
  };
}

const PROTECTED_PROCESSES = /^(launchd|WindowServer|loginwindow|kernel_task|Finder|Dock|SystemUIServer|coreaudiod|UserEventAgent|mds|mds_stores|opendirectoryd)$/;

async function actionProcessKill(params, emit = () => {}) {
  const pid = Number(params.pid);
  const name = typeof params.name === 'string' ? params.name : '';
  if (!Number.isInteger(pid) || pid <= 1) throw new HttpError(400, 'Invalid pid');
  if (pid === process.pid || pid === process.ppid) throw new HttpError(403, 'Refusing to signal the dashboard process');

  const result = await run('/bin/ps', ['-o', 'comm=', '-p', String(pid)], { timeout: 5000 });
  const comm = result.stdout.trim();
  if (!result.ok || !comm) throw new HttpError(404, 'Process not found');
  if (name && !comm.includes(name)) {
    throw new HttpError(409, 'Process no longer matches, it may have exited or the pid was reused');
  }
  const base = comm.split('/').pop();
  if (PROTECTED_PROCESSES.test(base)) throw new HttpError(403, `Refusing to signal protected process ${base}`);

  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error.code === 'EPERM'; // exists but owned by someone else
    }
  };

  emitStep(emit, 'term', `Asking ${base} (${pid}) to quit`, 'active');
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    if (error.code === 'ESRCH') {
      emitStep(emit, 'term', `${base} had already exited`, 'skip');
      return { message: `${base} (${pid}) had already exited` };
    }
    throw new HttpError(500, error.message);
  }
  emitStep(emit, 'term', `Sent SIGTERM to ${base}`, 'done');

  // Give it a moment to shut down cleanly, then force-quit if it ignored SIGTERM.
  emitStep(emit, 'wait', `Waiting for ${base} to exit`, 'active');
  for (let i = 0; i < 12 && alive(); i += 1) await new Promise((resolve) => setTimeout(resolve, 250));
  if (!alive()) {
    emitStep(emit, 'wait', `${base} exited cleanly`, 'done');
    return { message: `Quit ${base} (${pid})` };
  }

  emitStep(emit, 'wait', `${base} ignored SIGTERM`, 'skip');
  emitStep(emit, 'kill', `Force-quitting ${base}`, 'active');
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') throw new HttpError(500, `Could not force-quit ${base}: ${error.message}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
  const stillAlive = alive();
  emitStep(emit, 'kill', stillAlive ? `${base} is not responding to signals` : `Force-quit ${base}`, stillAlive ? 'failed' : 'done');
  return { message: stillAlive ? `${base} (${pid}) is not responding to signals` : `Force-quit ${base} (${pid})` };
}

async function actionPruneOrphans(emit = () => {}) {
  emitStep(emit, 'prune', 'Scanning Ollama blobs for orphans', 'active');
  const result = await pruneOllamaOrphans();
  emitStep(emit, 'prune', result.message || 'Pruned orphaned blobs', 'done');
  return { message: result.message };
}

async function actionEmptyTrash(emit = () => {}) {
  emitStep(emit, 'empty', 'Emptying the Trash', 'active');
  const result = await emptyTrash();
  emitStep(emit, 'empty', result.message || 'Trash emptied', 'done');
  return { message: result.message };
}

async function actionDiscardPartial(params) {
  const raw = params.path;
  if (typeof raw !== 'string' || !path.isAbsolute(raw)) throw new HttpError(400, 'Invalid path');
  const aria = raw.endsWith('.aria2') ? raw : `${raw}.aria2`;
  const target = aria.replace(/\.aria2$/, '');
  const undoMoves = [];
  for (const candidate of [aria, target]) {
    if (await exists(candidate)) {
      const moved = await moveToTrash(candidate);
      undoMoves.push({ from: moved.path, to: path.resolve(candidate) });
    }
  }
  return {
    message: undoMoves.length ? `Moved ${undoMoves.length} file${undoMoves.length === 1 ? '' : 's'} to Trash` : 'Nothing to discard',
    undoMoves: undoMoves.length ? undoMoves : null,
  };
}

async function actionOllamaUnloadAll(emit = () => {}) {
  const ps = (await fetchJson(`${OLLAMA_HOST}/api/ps`, 4000)) || { models: [] };
  const names = (ps.models || []).map((model) => model.name);
  if (!names.length) {
    emitStep(emit, 'unload', 'No models were loaded', 'skip');
    return { message: 'No models were loaded' };
  }
  emitStep(emit, 'unload', `Unloading ${names.length} model${names.length === 1 ? '' : 's'}`, 'active');
  let ok = 0;
  for (const name of names) {
    try {
      await actionOllamaUnload({ model: name });
      ok += 1;
    } catch {
      /* skip */
    }
  }
  emitStep(emit, 'unload', `Unloaded ${ok} of ${names.length} model${names.length === 1 ? '' : 's'}`, ok ? 'done' : 'failed');
  return { message: `Unloaded ${ok} of ${names.length} model(s)` };
}

async function actionOllamaBenchmark(params) {
  const model = assertModelName(params.model);
  return {
    job: createTaskJob('ollama.benchmark', { model }, async ({ log }) => {
      log(`Benchmarking ${model}…`);
      const response = await fetch(`${OLLAMA_HOST}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, prompt: 'Write a short paragraph about the ocean.', stream: false, options: { num_predict: 128 } }),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Ollama ${response.status}${text ? `: ${text.slice(0, 150)}` : ''}`);
      }
      const data = await response.json();
      const evalCount = data.eval_count || 0;
      const tokPerSec = data.eval_duration ? evalCount / (data.eval_duration / 1e9) : 0;
      const promptTokPerSec = data.prompt_eval_duration ? (data.prompt_eval_count || 0) / (data.prompt_eval_duration / 1e9) : 0;
      const loadMs = (data.load_duration || 0) / 1e6;
      metrics.recordBenchmark(model, { tokPerSec, promptTokPerSec, loadMs, evalCount });
      log(`Generated ${evalCount} tokens`);
      log(`Speed: ${tokPerSec.toFixed(1)} tok/s · load ${loadMs.toFixed(0)} ms`);
      return { message: `${model}: ${tokPerSec.toFixed(1)} tok/s` };
    }),
  };
}

const HF_DIR_RE = /^(checkpoints|loras|vae|controlnet|clip|clip_vision|unet|diffusion_models|text_encoders|upscale_models|embeddings|style_models|ipadapter|background_removal|audio_encoders|model_patches)$/;
const HF_REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const HF_FILE_RE = /^[A-Za-z0-9._/-]+$/;

async function actionHfDownload(params) {
  const repo = String(params.repo || '');
  const file = String(params.file || '');
  const dir = String(params.dir || '');
  if (!HF_REPO_RE.test(repo)) throw new HttpError(400, 'Invalid HuggingFace repo');
  if (!HF_FILE_RE.test(file) || file.includes('..')) throw new HttpError(400, 'Invalid file path');
  if (!HF_DIR_RE.test(dir)) throw new HttpError(400, 'Invalid target folder');

  const destDir = path.join(HOME, 'ComfyUI', 'models', dir);
  await fs.mkdir(destDir, { recursive: true });
  const out = file.split('/').pop();
  const url = `https://huggingface.co/${repo}/resolve/main/${file}?download=true`;
  const bin = await resolveBin('aria2c');
  return { job: spawnJob('hf.download', { repo, file, dir }, bin, ['-x', '8', '-s', '8', '-k', '1M', '--file-allocation=none', '--summary-interval=0', '-d', destDir, '-o', out, url], { cwd: destDir }) };
}

const QUANT_TYPES = /^(Q2_K|Q3_K_S|Q3_K_M|Q3_K_L|Q4_0|Q4_1|Q4_K_S|Q4_K_M|Q5_0|Q5_1|Q5_K_S|Q5_K_M|Q6_K|Q8_0|F16|F32)$/;

async function actionLlamaQuantize(params) {
  const input = String(params.input || '');
  const output = String(params.output || '');
  const type = String(params.type || 'Q4_K_M').toUpperCase();
  if (!path.isAbsolute(input) || !path.isAbsolute(output)) throw new HttpError(400, 'Absolute paths are required');
  if (!input.startsWith(HOME + path.sep) || !output.startsWith(HOME + path.sep)) throw new HttpError(403, 'Paths must be under your home directory');
  if (!QUANT_TYPES.test(type)) throw new HttpError(400, 'Unsupported quantization type');
  if (!(await exists(input))) throw new HttpError(404, 'Input file not found');
  const bin = await resolveBin('llama-quantize');
  return { job: spawnJob('llama.quantize', { input, output, type }, bin, [input, output, type]) };
}

// --- registry --------------------------------------------------------------

// --- OpenClaw pause / resume ----------------------------------------------

const OPENCLAW_SERVICES = ['ai.openclaw.gateway', 'ai.openclaw.miniapp', 'ai.openclaw.miniapp-refresh'];
const PAUSE_STATE_FILE = path.join(DATA_DIR, 'openclaw-pause.json');

async function serviceRunningMap() {
  const result = await run('/bin/launchctl', ['list'], { timeout: 10_000 });
  const map = new Map();
  for (const line of result.stdout.split('\n').slice(1)) {
    const parts = line.split('\t');
    if (parts.length >= 3 && parts[2]) map.set(parts[2], parts[0] !== '-');
  }
  return map;
}

async function openclawState() {
  const [state, labels, running] = await Promise.all([readJsonSafe(PAUSE_STATE_FILE), knownServiceLabels(), serviceRunningMap()]);
  const services = OPENCLAW_SERVICES.filter((label) => labels.has(label)).map((label) => ({ label, running: running.get(label) || false }));
  const anyRunning = services.some((service) => service.running);
  return {
    paused: Boolean(state) && !anyRunning,
    pausedAt: state ? state.pausedAt || null : null,
    stopped: state ? state.stopped || [] : [],
    unloaded: state ? state.unloaded || [] : [],
    services,
  };
}

async function actionOpenclawPause(params = {}) {
  const unload = params.unloadModels !== false;
  const labels = await knownServiceLabels();
  const stopped = [];
  for (const label of OPENCLAW_SERVICES) {
    if (!labels.has(label)) continue;
    const result = await run('/bin/launchctl', ['bootout', `gui/${UID}/${label}`], { timeout: 20_000 });
    if (result.ok || /no such process|not find/i.test(result.stderr)) stopped.push(label);
  }

  const unloaded = [];
  if (unload) {
    const ps = (await fetchJson(`${OLLAMA_HOST}/api/ps`, 4000)) || { models: [] };
    for (const model of ps.models || []) {
      try {
        await actionOllamaUnload({ model: model.name });
        unloaded.push(model.name);
      } catch {
        /* skip */
      }
    }
  }

  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(PAUSE_STATE_FILE, JSON.stringify({ pausedAt: Date.now(), stopped, unloaded }, null, 2));

  const parts = [`${stopped.length} service${stopped.length === 1 ? '' : 's'} stopped`];
  if (unloaded.length) parts.push(`${unloaded.length} model${unloaded.length === 1 ? '' : 's'} unloaded`);
  return { message: `Paused OpenClaw, ${parts.join(', ')}` };
}

async function actionOpenclawResume() {
  const state = (await readJsonSafe(PAUSE_STATE_FILE)) || {};
  const labels = await knownServiceLabels();
  const targets = (state.stopped && state.stopped.length ? state.stopped : OPENCLAW_SERVICES).filter((label) => labels.has(label));
  const started = [];
  for (const label of targets) {
    const target = `gui/${UID}/${label}`;
    const plist = path.join(LAUNCH_AGENTS, `${label}.plist`);
    if (await exists(plist)) await run('/bin/launchctl', ['bootstrap', `gui/${UID}`, plist], { timeout: 20_000 });
    const result = await run('/bin/launchctl', ['kickstart', '-k', target], { timeout: 20_000 });
    if (result.ok) started.push(label);
  }
  try {
    await fs.unlink(PAUSE_STATE_FILE);
  } catch {
    /* ignore */
  }
  return { message: `Resumed OpenClaw, ${started.length} service${started.length === 1 ? '' : 's'} started` };
}

const ACTIONS = {
  'ollama.pull': {
    label: 'Pull model',
    description: 'Download a model from the Ollama registry.',
    danger: 'low',
    mode: 'job',
    params: [{ name: 'model', type: 'text', label: 'Model tag', placeholder: 'e.g. llama3.2:3b', required: true }],
    handler: actionOllamaPull,
  },
  'ollama.load': {
    label: 'Load into memory',
    description: 'Preload a model into RAM so first response is fast.',
    danger: 'low',
    mode: 'sync',
    params: [{ name: 'model', type: 'hidden' }],
    handler: actionOllamaLoad,
  },
  'ollama.unload': {
    label: 'Unload from memory',
    description: 'Free the memory used by a loaded model.',
    danger: 'low',
    mode: 'sync',
    params: [{ name: 'model', type: 'hidden' }],
    handler: actionOllamaUnload,
  },
  'ollama.remove': {
    label: 'Delete model',
    description: 'Permanently remove a model and its blobs from disk.',
    danger: 'high',
    mode: 'job',
    confirm: true,
    typeToConfirm: 'delete',
    params: [{ name: 'model', type: 'hidden' }],
    handler: actionOllamaRemove,
  },
  'ollama.removeMany': {
    label: 'Delete unused models',
    description: 'Permanently remove several unused models.',
    danger: 'high',
    mode: 'job',
    confirm: true,
    typeToConfirm: 'delete',
    params: [{ name: 'models', type: 'hidden' }],
    handler: actionOllamaRemoveMany,
  },
  'service.start': {
    label: 'Start service',
    description: 'Load and start a launchd service.',
    danger: 'medium',
    mode: 'sync',
    stream: true,
    params: [{ name: 'label', type: 'hidden' }],
    handler: (params, emit) => serviceAction('start', params, emit),
  },
  'service.stop': {
    label: 'Stop service',
    description: 'Unload a launchd service until it is started again.',
    danger: 'medium',
    mode: 'sync',
    confirm: true,
    stream: true,
    params: [{ name: 'label', type: 'hidden' }],
    handler: (params, emit) => serviceAction('stop', params, emit),
  },
  'service.restart': {
    label: 'Restart service',
    description: 'Kickstart a launchd service.',
    danger: 'medium',
    mode: 'sync',
    stream: true,
    params: [{ name: 'label', type: 'hidden' }],
    handler: (params, emit) => serviceAction('restart', params, emit),
  },
  'file.trash': {
    label: 'Move to Trash',
    description: 'Move a file to the Trash (recoverable).',
    danger: 'high',
    mode: 'sync',
    confirm: true,
    stream: true,
    params: [{ name: 'path', type: 'hidden' }],
    handler: actionFileTrash,
  },
  'file.reveal': {
    label: 'Reveal in Finder',
    description: 'Show a file in Finder.',
    danger: 'low',
    mode: 'sync',
    params: [{ name: 'path', type: 'hidden' }],
    handler: actionFileReveal,
  },
  'cache.prune': {
    label: 'Prune cache',
    description: 'Clear a download cache.',
    danger: 'medium',
    mode: 'job',
    confirm: true,
    params: [{ name: 'target', type: 'hidden' }],
    handler: actionCachePrune,
  },
  'brew.cleanup': {
    label: 'Clean up Homebrew',
    description: 'Remove old versions and stale downloads.',
    danger: 'medium',
    mode: 'sync',
    confirm: true,
    params: [],
    handler: actionBrewCleanup,
  },
  'process.kill': {
    label: 'Quit process',
    description: 'Send SIGTERM to a process. Managed services may restart.',
    danger: 'high',
    mode: 'sync',
    confirm: true,
    stream: true,
    params: [
      { name: 'pid', type: 'hidden' },
      { name: 'name', type: 'hidden' },
    ],
    handler: actionProcessKill,
  },
  'ollama.pruneOrphans': {
    label: 'Prune orphaned blobs',
    description: 'Permanently delete Ollama blobs that no model manifest references.',
    danger: 'high',
    mode: 'sync',
    confirm: true,
    typeToConfirm: 'delete',
    stream: true,
    params: [],
    handler: actionPruneOrphans,
  },
  'system.cleanAll': {
    label: 'Clean up everything safe',
    description: 'Empty the Trash, prune caches and orphaned blobs, and discard partial and stale files.',
    danger: 'high',
    mode: 'sync',
    confirm: false,
    stream: true,
    params: [{ name: 'items', type: 'hidden' }],
    handler: actionSystemCleanAll,
  },
  'maintenance.caffeinate': {
    label: 'Keep awake',
    description: 'Prevent display, idle, disk and system sleep while long jobs run.',
    mode: 'sync',
    confirm: false,
    params: [{ name: 'on', type: 'hidden' }],
    handler: actionMaintenanceCaffeinate,
  },
  'maintenance.ollamaProfile': {
    label: 'Apply Ollama profile',
    description: 'Tune Ollama keep-alive, parallelism and max loaded models.',
    mode: 'sync',
    confirm: false,
    stream: true,
    params: [{ name: 'profile', type: 'hidden' }],
    handler: actionMaintenanceOllamaProfile,
  },
  'maintenance.loginItem': {
    label: 'Toggle login item',
    description: 'Load or unload a LaunchAgent.',
    mode: 'sync',
    confirm: false,
    params: [{ name: 'name', type: 'hidden' }, { name: 'enabled', type: 'hidden' }],
    handler: actionMaintenanceLoginItem,
  },
  'maintenance.backupNow': {
    label: 'Back up now',
    description: 'Start a Time Machine backup.',
    mode: 'sync',
    confirm: false,
    stream: true,
    params: [],
    handler: actionMaintenanceBackupNow,
  },
  'system.openNotificationSettings': {
    label: 'Open Notification settings',
    description: 'Open macOS System Settings → Notifications.',
    danger: 'low',
    mode: 'sync',
    params: [],
    handler: async () => {
      await run('/usr/bin/open', ['x-apple.systempreferences:com.apple.preference.notifications']);
      return { message: 'Opened Notification settings' };
    },
  },
  'system.openFullDiskAccess': {
    label: 'Open Full Disk Access',
    description: 'Open macOS System Settings → Privacy & Security → Full Disk Access.',
    danger: 'low',
    mode: 'sync',
    params: [],
    handler: async () => {
      await run('/usr/bin/open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles']);
      return { message: 'Opened Full Disk Access settings' };
    },
  },
  'system.openLoginItems': {
    label: 'Open Login Items',
    description: 'Open macOS System Settings → General → Login Items.',
    danger: 'low',
    mode: 'sync',
    params: [],
    handler: async () => {
      await run('/usr/bin/open', ['x-apple.systempreferences:com.apple.LoginItems-Settings.extension']);
      return { message: 'Opened Login Items settings' };
    },
  },
  'system.openTouchIdSettings': {
    label: 'Open Touch ID settings',
    description: 'Open macOS System Settings → Touch ID & Password.',
    danger: 'low',
    mode: 'sync',
    params: [],
    handler: async () => {
      await run('/usr/bin/open', ['x-apple.systempreferences:com.apple.Touch-ID-Settings.extension']);
      return { message: 'Opened Touch ID settings' };
    },
  },
  'system.openTouchIdSettings': {
    label: 'Open Touch ID settings',
    description: 'Open macOS System Settings → Touch ID & Password.',
    danger: 'low',
    mode: 'sync',
    params: [],
    handler: async () => {
      await run('/usr/bin/open', ['x-apple.systempreferences:com.apple.Touch-ID-Settings.extension']);
      return { message: 'Opened Touch ID settings' };
    },
  },
  'system.restartService': {
    label: 'Restart Vantage server',
    description: 'Reload the launchd service that runs the Vantage server.',
    danger: 'medium',
    mode: 'sync',
    confirm: true,
    params: [],
    handler: async () => {
      const uid = typeof process.getuid === 'function' ? process.getuid() : null;
      if (uid == null) throw new HttpError(400, 'Unsupported platform');
      // Answer first, then bounce the service so this response gets delivered.
      setTimeout(() => { run('/bin/launchctl', ['kickstart', '-k', `gui/${uid}/local.vantage`]).catch(() => {}); }, 700);
      return { message: 'Restarting Vantage…' };
    },
  },
  'native.launch': {
    label: 'Open as native app',
    description: 'Build and open the dashboard as a Mac app with a menu bar extra.',
    mode: 'job',
    confirm: false,
    params: [],
    handler: actionNativeLaunch,
  },
  'trash.empty': {
    label: 'Empty Trash',
    description: 'Permanently delete everything in the Trash.',
    danger: 'high',
    mode: 'sync',
    confirm: true,
    typeToConfirm: 'delete',
    stream: true,
    params: [],
    handler: actionEmptyTrash,
  },
  'download.discard': {
    label: 'Discard download',
    description: 'Move an incomplete download to the Trash.',
    danger: 'medium',
    mode: 'sync',
    confirm: true,
    params: [{ name: 'path', type: 'hidden' }],
    handler: actionDiscardPartial,
  },
  'ollama.benchmark': {
    label: 'Benchmark model',
    description: 'Measure generation speed (tokens/sec) on this machine.',
    danger: 'low',
    mode: 'job',
    params: [{ name: 'model', type: 'hidden' }],
    handler: actionOllamaBenchmark,
  },
  'ollama.unloadAll': {
    label: 'Unload all models',
    description: 'Free all unified memory held by loaded models.',
    danger: 'low',
    mode: 'sync',
    stream: true,
    params: [],
    handler: actionOllamaUnloadAll,
  },
  'hf.download': {
    label: 'Download from HuggingFace',
    description: 'Fetch a model file into ComfyUI.',
    danger: 'medium',
    mode: 'job',
    params: [
      { name: 'repo', type: 'hidden' },
      { name: 'file', type: 'hidden' },
      { name: 'dir', type: 'hidden' },
    ],
    handler: actionHfDownload,
  },
  'llama.quantize': {
    label: 'Quantize GGUF',
    description: 'Quantize a GGUF file with llama.cpp.',
    danger: 'medium',
    mode: 'job',
    confirm: true,
    params: [
      { name: 'input', type: 'text', label: 'Input GGUF path', placeholder: '/Users/bernie/models/model-F16.gguf', required: true },
      { name: 'output', type: 'text', label: 'Output path', placeholder: '/Users/bernie/models/model-Q4_K_M.gguf', required: true },
      { name: 'type', type: 'text', label: 'Quantization type', placeholder: 'Q4_K_M', required: true },
    ],
    handler: actionLlamaQuantize,
  },
  'app.open': {
    label: 'Open application',
    description: 'Launch an application.',
    danger: 'low',
    mode: 'sync',
    stream: true,
    params: [{ name: 'path', type: 'hidden' }],
    handler: actionAppOpen,
  },
  'app.quit': {
    label: 'Quit application',
    description: 'Ask an application to quit.',
    danger: 'medium',
    mode: 'sync',
    confirm: true,
    stream: true,
    params: [{ name: 'name', type: 'hidden' }],
    handler: actionAppQuit,
  },
  'app.trash': {
    label: 'Move app to Trash',
    description: 'Move an application bundle to the Trash (recoverable).',
    danger: 'high',
    mode: 'sync',
    confirm: true,
    stream: true,
    params: [{ name: 'path', type: 'hidden' }],
    handler: actionAppTrash,
  },
  'app.remove': {
    label: 'Remove app completely',
    description: 'Move the app bundle and the files it left in ~/Library (caches, preferences, containers, logs, launch agents) to the Trash. Recoverable.',
    danger: 'high',
    mode: 'sync',
    confirm: true,
    stream: true,
    params: [{ name: 'path', type: 'hidden' }, { name: 'leftovers', type: 'hidden' }],
    handler: actionAppRemove,
  },
  'app.removeMany': {
    label: 'Remove apps completely',
    description: 'Move each selected app bundle and the files it left in ~/Library to the Trash. Recoverable.',
    danger: 'high',
    mode: 'sync',
    confirm: true,
    stream: true,
    params: [{ name: 'paths', type: 'hidden' }],
    handler: actionAppsRemove,
  },
  'app.trashMany': {
    label: 'Move apps to Trash',
    description: 'Move each selected application bundle to the Trash (recoverable).',
    danger: 'high',
    mode: 'sync',
    confirm: true,
    stream: true,
    params: [{ name: 'paths', type: 'hidden' }],
    handler: actionAppsTrash,
  },
  'brew.install': {
    label: 'Install package',
    description: 'Install a Homebrew formula or cask.',
    danger: 'medium',
    mode: 'job',
    params: [{ name: 'name', type: 'hidden' }, { name: 'kind', type: 'hidden' }],
    handler: actionBrewInstall,
  },
  'brew.uninstall': {
    label: 'Uninstall package',
    description: 'Remove a Homebrew formula or cask.',
    danger: 'high',
    mode: 'job',
    confirm: true,
    typeToConfirm: 'uninstall',
    params: [{ name: 'name', type: 'hidden' }, { name: 'kind', type: 'hidden' }],
    handler: actionBrewUninstall,
  },
  'brew.upgrade': {
    label: 'Upgrade package',
    description: 'Upgrade a single Homebrew package.',
    danger: 'medium',
    mode: 'job',
    params: [{ name: 'name', type: 'hidden' }],
    handler: actionBrewUpgrade,
  },
  'brew.upgradeAll': {
    label: 'Upgrade all packages',
    description: 'Upgrade every outdated Homebrew package.',
    danger: 'high',
    mode: 'job',
    confirm: true,
    params: [],
    handler: actionBrewUpgradeAll,
  },
  'downloads.clear': {
    label: 'Clear Downloads',
    description: 'Move everything in ~/Downloads to the Trash.',
    danger: 'high',
    mode: 'sync',
    confirm: true,
    stream: true,
    params: [],
    handler: actionDownloadsClear,
  },
  'npm.uninstall': {
    label: 'Uninstall npm package',
    description: 'Remove a global npm package.',
    danger: 'high',
    mode: 'job',
    confirm: true,
    typeToConfirm: 'uninstall',
    params: [{ name: 'name', type: 'hidden' }],
    handler: actionNpmUninstall,
  },
  'npm.update': {
    label: 'Update npm package',
    description: 'Upgrade a global npm package to the latest version.',
    danger: 'medium',
    mode: 'job',
    params: [{ name: 'name', type: 'hidden' }],
    handler: actionNpmUpdate,
  },
  'npm.updateAll': {
    label: 'Update all npm packages',
    description: 'Upgrade every outdated global npm package.',
    danger: 'medium',
    mode: 'job',
    params: [],
    handler: actionNpmUpdateAll,
  },
  'pip.upgradeAll': {
    label: 'Update all Python packages',
    description: 'Upgrade every outdated pip package for an interpreter.',
    danger: 'medium',
    mode: 'job',
    params: [{ name: 'label', type: 'hidden' }],
    handler: actionPipUpgradeAll,
  },
  'pip.upgrade': {
    label: 'Update Python package',
    description: 'Upgrade an installed pip package to the latest version.',
    danger: 'medium',
    mode: 'job',
    params: [{ name: 'name', type: 'hidden' }, { name: 'label', type: 'hidden' }],
    handler: actionPipUpgrade,
  },
  'openclaw.pause': {
    label: 'Pause OpenClaw',
    description: 'Stop the OpenClaw gateway and miniapp and unload local models.',
    danger: 'medium',
    mode: 'sync',
    confirm: true,
    params: [{ name: 'unloadModels', type: 'hidden' }],
    handler: actionOpenclawPause,
  },
  'openclaw.resume': {
    label: 'Resume OpenClaw',
    description: 'Start the OpenClaw services again.',
    danger: 'low',
    mode: 'sync',
    params: [],
    handler: actionOpenclawResume,
  },
};

function getActionMeta(id) {
  const action = ACTIONS[id];
  return action ? { id, label: action.label, danger: action.danger, mode: action.mode, confirm: Boolean(action.confirm) } : null;
}

function listActions() {
  return Object.entries(ACTIONS).map(([id, action]) => ({
    id,
    label: action.label,
    description: action.description,
    danger: action.danger,
    mode: action.mode,
    confirm: Boolean(action.confirm),
    stream: Boolean(action.stream),
    typeToConfirm: action.typeToConfirm || null,
    params: (action.params || []).map((param) => ({ name: param.name, type: param.type, label: param.label, placeholder: param.placeholder, required: Boolean(param.required) })),
  }));
}

async function runAction(id, params = {}, emit = () => {}) {
  const action = ACTIONS[id];
  if (!action) throw new HttpError(404, `Unknown action "${id}"`);
  for (const param of action.params || []) {
    if (param.required && (params[param.name] == null || params[param.name] === '')) {
      throw new HttpError(400, `Missing required parameter "${param.name}"`);
    }
  }
  const result = await action.handler(params, emit);
  if (result && result.job) {
    const historyId = metrics.recordAction({ action: id, params, status: 'running' });
    result.job.historyId = historyId;
    return { ok: true, jobId: result.job.id, mode: 'job', historyId };
  }
  const undoMoves = (result && result.undoMoves) || null;
  const historyId = metrics.recordAction({
    action: id,
    params,
    status: 'done',
    message: result && result.message,
    undoable: Boolean(undoMoves),
    undoMoves,
  });
  return {
    ok: true,
    mode: 'sync',
    message: (result && result.message) || 'Done',
    output: result && result.output ? result.output : undefined,
    historyId,
    undoable: Boolean(undoMoves),
  };
}

async function undoAction(historyId) {
  const entry = metrics.getAction(Number(historyId));
  if (!entry) throw new HttpError(404, 'History entry not found');
  if (!entry.undoable || entry.undone) throw new HttpError(400, 'This action cannot be undone');
  const trashDir = path.join(HOME, '.Trash');
  let restored = 0;
  for (const move of entry.undoMoves || []) {
    const from = path.resolve(String(move.from));
    const to = path.resolve(String(move.to));
    if (!from.startsWith(trashDir + path.sep)) continue;
    if (!to.startsWith(HOME + path.sep)) continue;
    try {
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.rename(from, to);
      restored += 1;
    } catch {
      /* skip */
    }
  }
  metrics.markUndone(entry.id);
  return { message: restored ? `Restored ${restored} item${restored === 1 ? '' : 's'}` : 'Nothing to restore' };
}

module.exports = { listActions, getActionMeta, runAction, undoAction, getJob, listJobs, openclawState, HttpError };
