'use strict';

// One-click maintenance: keep-awake, Ollama tuning presets, login items, backup.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const fssync = require('node:fs');
const { spawn } = require('node:child_process');

const { run } = require('./exec');

const HOME = os.homedir();
const LA_DIR = path.join(HOME, 'Library', 'LaunchAgents');
const STATE = path.join(__dirname, '..', 'data', 'maintenance.json');

const OLLAMA_ENV = ['OLLAMA_KEEP_ALIVE', 'OLLAMA_NUM_PARALLEL', 'OLLAMA_MAX_LOADED_MODELS'];
const PROFILES = {
  battery: { OLLAMA_KEEP_ALIVE: '5m', OLLAMA_NUM_PARALLEL: '1', OLLAMA_MAX_LOADED_MODELS: '1' },
  balanced: { OLLAMA_KEEP_ALIVE: '15m', OLLAMA_NUM_PARALLEL: '2', OLLAMA_MAX_LOADED_MODELS: '2' },
  max: { OLLAMA_KEEP_ALIVE: '-1', OLLAMA_NUM_PARALLEL: '4', OLLAMA_MAX_LOADED_MODELS: '4' },
};

let state = { caffeinatePid: null };

async function loadState() {
  try {
    state = { ...state, ...JSON.parse(await fs.readFile(STATE, 'utf8')) };
  } catch {
    /* first run */
  }
}

async function saveState() {
  await fs.mkdir(path.dirname(STATE), { recursive: true });
  await fs.writeFile(STATE, JSON.stringify(state));
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function ollamaEnv() {
  const out = {};
  for (const key of OLLAMA_ENV) {
    const result = await run('/bin/launchctl', ['getenv', key], { timeout: 5000 });
    out[key] = result.ok ? result.stdout.trim() || null : null;
  }
  return out;
}

async function loginItems() {
  let files = [];
  try {
    files = await fs.readdir(LA_DIR);
  } catch {
    return [];
  }
  const items = files.filter((f) => f.endsWith('.plist')).map((file) => {
    const label = file.replace(/\.plist$/, '');
    return { name: label, label, file, path: path.join(LA_DIR, file), loaded: false };
  });
  const loaded = await run('/bin/launchctl', ['list'], { timeout: 8000 });
  const loadedLabels = new Set((loaded.stdout || '').split('\n').slice(1).map((line) => line.trim().split(/\s+/).pop()).filter(Boolean));
  for (const item of items) item.loaded = loadedLabels.has(item.label);
  items.sort((a, b) => a.name.localeCompare(b.name));
  return items;
}

async function lastBackup() {
  const result = await run('/usr/bin/tmutil', ['latestbackup'], { timeout: 8000 });
  return result.ok ? result.stdout.trim() || null : null;
}

async function status() {
  await loadState();
  if (!pidAlive(state.caffeinatePid)) state.caffeinatePid = null;
  const [env, items, last] = await Promise.all([ollamaEnv(), loginItems(), lastBackup()]);
  let profile = null;
  for (const [name, values] of Object.entries(PROFILES)) {
    if (Object.entries(values).every(([key, value]) => env[key] === value)) profile = name;
  }
  return {
    caffeinate: { on: pidAlive(state.caffeinatePid), pid: state.caffeinatePid },
    ollama: { env, profile },
    profiles: Object.keys(PROFILES),
    loginItems: items,
    backup: { last },
  };
}

async function setCaffeinate(on) {
  await loadState();
  if (on) {
    if (pidAlive(state.caffeinatePid)) return { message: 'Already keeping this Mac awake' };
    const child = spawn('/usr/bin/caffeinate', ['-dims'], { detached: true, stdio: 'ignore' });
    child.unref();
    state.caffeinatePid = child.pid;
    await saveState();
    return { message: 'Keeping this Mac awake (display, idle, disk, system)' };
  }
  if (pidAlive(state.caffeinatePid)) {
    try {
      process.kill(state.caffeinatePid);
    } catch {
      /* already gone */
    }
  }
  state.caffeinatePid = null;
  await saveState();
  return { message: 'Normal sleep behaviour restored' };
}

async function setOllamaProfile(profileName) {
  const profile = PROFILES[profileName];
  if (!profile) {
    const error = new Error('Unknown profile');
    error.status = 400;
    throw error;
  }
  for (const [key, value] of Object.entries(profile)) {
    await run('/bin/launchctl', ['setenv', key, value], { timeout: 5000 });
  }
  const restart = await run('/opt/homebrew/bin/brew', ['services', 'restart', 'ollama'], { timeout: 60_000 });
  const note = restart.ok ? '' : ` (restart: ${(restart.stderr || '').trim().slice(0, 80) || 'check service name'})`;
  return { message: `Ollama profile “${profileName}” applied${note}` };
}

async function setLoginItem(name, enabled) {
  const label = String(name || '').replace(/\.plist$/, '');
  const file = path.join(LA_DIR, `${label}.plist`);
  if (!fssync.existsSync(file)) {
    const error = new Error('Login item not found');
    error.status = 404;
    throw error;
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : '';
  const domain = `gui/${uid}`;
  if (enabled) {
    await run('/bin/launchctl', ['bootstrap', domain, file], { timeout: 10_000 });
    await run('/bin/launchctl', ['enable', `${domain}/${label}`], { timeout: 10_000 });
    return { message: `Enabled ${label}` };
  }
  await run('/bin/launchctl', ['bootout', `${domain}/${label}`], { timeout: 10_000 });
  await run('/bin/launchctl', ['disable', `${domain}/${label}`], { timeout: 10_000 });
  return { message: `Disabled ${label}` };
}

async function backupNow() {
  const result = await run('/usr/bin/tmutil', ['startbackup', '--auto'], { timeout: 20_000 });
  return { message: result.ok ? 'Time Machine backup started' : `Backup: ${(result.stderr || result.stdout || 'unavailable').trim().slice(0, 120)}` };
}

module.exports = { status, setCaffeinate, setOllamaProfile, setLoginItem, backupNow, PROFILES };
