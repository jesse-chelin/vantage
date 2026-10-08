'use strict';

// Notifications: macOS banners + Telegram, with a background watcher for disk,
// job and service-state events. Settings live in data/settings.json.

const os = require('node:os');
const fs = require('node:fs/promises');
const fssync = require('node:fs');
const path = require('node:path');

const { run, readJsonSafe, readTextSafe } = require('./exec');

// osascript notifications are attributed to "Script Editor" and are frequently
// suppressed; terminal-notifier is a signed app and far more reliable. Prefer it
// when installed.
const TERMINAL_NOTIFIER_PATHS = ['/opt/homebrew/bin/terminal-notifier', '/usr/local/bin/terminal-notifier'];
let cachedNotifier = null;

// Resolved live so installing the helper takes effect without a server restart.
function terminalNotifier() {
  if (cachedNotifier && fssync.existsSync(cachedNotifier)) return cachedNotifier;
  cachedNotifier = TERMINAL_NOTIFIER_PATHS.find((candidate) => fssync.existsSync(candidate)) || null;
  return cachedNotifier;
}

function macNotifier() {
  return terminalNotifier() ? 'terminal-notifier' : 'osascript';
}
const push = require('./push');

const HOME = os.homedir();
const DATA_DIR = process.env.VANTAGE_DATA_DIR || path.join(__dirname, '..', 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const DEFAULTS = {
  enabled: true,
  macos: true,
  telegram: true,
  telegramChatId: null,
  diskFreePctThreshold: 10,
  notifyJobDone: true,
  notifyJobFailed: true,
  notifyServiceDown: true,
  cooldownMinutes: 30,
  push: true,
};

let cache = null;
let watcher = null;
const cooldowns = new Map();
const jobStates = new Map();
const endpointStates = new Map();
let tickCount = 0;

function fmtBytes(bytes) {
  if (bytes == null) return '–';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(Math.max(1, bytes)) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(1)} ${units[i]}`;
}

async function loadSettings() {
  if (cache) return cache;
  const stored = await readJsonSafe(SETTINGS_FILE);
  cache = { ...DEFAULTS, ...(stored || {}) };
  return cache;
}

async function saveSettings(patch) {
  const current = await loadSettings();
  const next = { ...current };
  for (const key of Object.keys(DEFAULTS)) {
    if (patch[key] !== undefined) {
      if (typeof DEFAULTS[key] === 'boolean') next[key] = Boolean(patch[key]);
      else if (typeof DEFAULTS[key] === 'number') next[key] = Number(patch[key]);
      else next[key] = patch[key];
    }
  }
  cache = next;
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(SETTINGS_FILE, JSON.stringify(next, null, 2));
  return next;
}

async function envVar(name) {
  const files = [path.join(HOME, '.openclaw', '.env'), path.join(HOME, '.openclaw', 'service-env', 'ai.openclaw.gateway.env')];
  for (const file of files) {
    const text = await readTextSafe(file);
    if (!text) continue;
    for (const line of text.split('\n')) {
      const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (match && match[1] === name) return match[2].replace(/^["']|["']$/g, '');
    }
  }
  return null;
}

function extractOwnerChat(config) {
  const found = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    for (const [key, value] of Object.entries(node)) {
      if (key === 'ownerAllowFrom' && Array.isArray(value)) {
        for (const item of value) {
          const match = String(item).match(/telegram:(-?\d+)/);
          if (match) found.push(match[1]);
        }
      } else {
        walk(value);
      }
    }
  };
  walk(config);
  return found[0] || null;
}

async function creds() {
  const settings = await loadSettings();
  const token = await envVar('TELEGRAM_BOT_TOKEN');
  let chatId = settings.telegramChatId;
  if (!chatId) {
    const config = await readJsonSafe(path.join(HOME, '.openclaw', 'openclaw.json'));
    chatId = extractOwnerChat(config);
  }
  return { token, chatId };
}

function appleScriptString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

async function sendMacOS(title, body) {
  const notifier = terminalNotifier();
  if (notifier) {
    const result = await run(notifier, ['-title', title, '-message', body, '-sound', 'default', '-ignoreDnD'], { timeout: 10_000 });
    if (result.ok) return true;
  }
  const script = `display notification ${appleScriptString(body)} with title ${appleScriptString(title)}`;
  const result = await run('/usr/bin/osascript', ['-e', script], { timeout: 10_000 });
  if (!result.ok) throw new Error(result.stderr.trim() || result.error || 'osascript failed');
  return true;
}

async function sendTelegram(text) {
  const { token, chatId } = await creds();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN not found');
  if (!chatId) throw new Error('No Telegram chat id configured');
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.description || `Telegram HTTP ${response.status}`);
  return true;
}

async function notify(key, title, body, options = {}) {
  const settings = await loadSettings();
  if (!settings.enabled && !options.force) return [];
  const cooldownMs = (settings.cooldownMinutes || 30) * 60_000;
  const last = cooldowns.get(key) || 0;
  if (!options.force && Date.now() - last < cooldownMs) return [];
  cooldowns.set(key, Date.now());

  const results = [];
  if (settings.macos || options.force) {
    results.push({ channel: 'macos', ok: await sendMacOS(title, body).then(() => true).catch((e) => e.message) });
  }
  if (settings.telegram || options.channel === 'telegram') {
    results.push({ channel: 'telegram', ok: await sendTelegram(`${title}\n${body}`).then(() => true).catch((e) => e.message) });
  }
  if (settings.push !== false) {
    results.push({ channel: 'push', ok: await push.broadcast(title, body).then((r) => (r.length ? `sent to ${r.length}` : 'no-subscriptions')).catch((e) => e.message) });
  }
  return results;
}

async function test(channel) {
  const title = 'Vantage test';
  const body = `Test notification at ${new Date().toLocaleTimeString()}`;
  if (channel === 'macos') {
    await sendMacOS(title, body);
    return {
      message: terminalNotifier() ? 'Posted via terminal-notifier' : 'Posted via osascript',
      notifier: macNotifier(),
    };
  }
  if (channel === 'telegram') {
    await sendTelegram(`${title}\n${body}`);
    return { message: 'Sent Telegram message' };
  }
  if (channel === 'push') {
    const results = await push.broadcast(title, body);
    return { message: results.length ? `Pushed to ${results.length} subscription(s)` : 'No push subscriptions registered' };
  }
  const results = await notify(`test:${Date.now()}`, title, body, { force: true });
  return { message: JSON.stringify(results) };
}

async function info() {
  const settings = await loadSettings();
  const { token, chatId } = await creds();
  const pushStatus = await push.status().catch(() => ({ subscriptions: 0, publicKey: null }));
  return { settings: { ...settings, telegramChatId: settings.telegramChatId || chatId }, telegramAvailable: Boolean(token), telegramChatId: chatId, pushSubscriptions: pushStatus.subscriptions, pushPublicKey: pushStatus.publicKey, macNotifier: macNotifier() };
}

async function tick(context) {
  const settings = await loadSettings();
  if (!settings.enabled) return;

  const sample = context.getSample ? context.getSample() : null;
  if (sample && sample.disk && sample.disk.total) {
    const pct = (sample.disk.free / sample.disk.total) * 100;
    if (pct < (settings.diskFreePctThreshold || 10)) {
      await notify('disk-free', 'Low disk space', `${pct.toFixed(1)}% free (${fmtBytes(sample.disk.free)} remaining).`);
    }
  }

  if (context.listJobs) {
    for (const job of context.listJobs()) {
      const previous = jobStates.get(job.id);
      if (previous === 'running' && job.status === 'done' && settings.notifyJobDone) {
        await notify(`job:${job.id}`, 'Job finished', job.actionId);
      }
      if (previous === 'running' && job.status === 'failed' && settings.notifyJobFailed) {
        await notify(`jobfail:${job.id}`, 'Job failed', job.actionId);
      }
      jobStates.set(job.id, job.status);
    }
  }

  tickCount += 1;
  if (context.endpointChecks && tickCount % 2 === 0) {
    const checks = await context.endpointChecks().catch(() => []);
    for (const check of checks) {
      const previous = endpointStates.get(check.id);
      if (previous && previous !== 'down' && check.status === 'down' && settings.notifyServiceDown) {
        await notify(`endpoint:${check.id}`, 'Service down', `${check.label} is not responding (${check.url}).`);
      }
      endpointStates.set(check.id, check.status);
    }
  }
}

function startWatcher(context, intervalMs = 30_000) {
  if (watcher) return;
  watcher = setInterval(() => {
    tick(context).catch((error) => console.error('[notify] tick failed:', error.message));
  }, intervalMs);
  watcher.unref?.();
}

function stopWatcher() {
  if (watcher) {
    clearInterval(watcher);
    watcher = null;
  }
}

module.exports = { loadSettings, saveSettings, notify, test, info, macNotifier, startWatcher, stopWatcher };
