'use strict';

// Consolidated settings: one declarative registry drives the Settings UI, the
// API, validation and defaults. Two server-side stores are aggregated here:
//   - data/prefs.json     (appearance + client behaviour, mirrored so it follows
//                          you across browsers/machines)
//   - data/settings.json  (notifications, via lib/notify.js)

const fs = require('node:fs/promises');
const fssync = require('node:fs');
const path = require('node:path');

const notify = require('./notify');

const DATA_DIR = process.env.VANTAGE_DATA_DIR || path.join(__dirname, '..', 'data');
const PREFS_FILE = path.join(DATA_DIR, 'prefs.json');

const SECTIONS = [
  { id: 'general', label: 'General', icon: 'app' },
  { id: 'appearance', label: 'Appearance', icon: 'sparkle' },
  { id: 'notifications', label: 'Notifications', icon: 'bell' },
  { id: 'security', label: 'Security', icon: 'shield' },
  { id: 'capabilities', label: 'Capabilities', icon: 'bolt' },
  { id: 'data', label: 'Data', icon: 'database' },
  { id: 'advanced', label: 'Advanced', icon: 'gears' },
  { id: 'about', label: 'About', icon: 'user' },
];

const PREF_DEFAULTS = {
  accent: 'system',
  density: 'comfortable',
  motion: 'auto',
  material: 'glass',
  sidebar: 'expanded',
  notifyBrowser: false,
  wakeLock: true,
  idlePause: true,
};

const REGISTRY = [
  // Appearance
  { id: 'appearance.accent', section: 'appearance', label: 'Accent colour', icon: 'sparkle', type: 'select', default: 'system', store: 'prefs', options: ['system', 'indigo', 'blue', 'purple', 'green', 'pink', 'orange', 'red', 'yellow', 'graphite'] },
  { id: 'appearance.density', section: 'appearance', label: 'Density', icon: 'grid', help: 'Comfortable spacing, or compact to fit more on screen.', type: 'select', default: 'comfortable', store: 'prefs', options: ['comfortable', 'compact'] },
  { id: 'appearance.material', section: 'appearance', label: 'Material', icon: 'layers', help: 'Translucent surfaces, most visible in the native Mac app.', type: 'select', default: 'glass', store: 'prefs', options: ['glass', 'solid'] },
  { id: 'appearance.motion', section: 'appearance', label: 'Motion', icon: 'bolt', help: 'Reduce animations and transitions.', type: 'select', default: 'auto', store: 'prefs', options: ['auto', 'reduce'] },
  { id: 'appearance.sidebar', section: 'appearance', label: 'Sidebar', icon: 'sidebar', help: 'Show the navigation expanded or collapsed.', type: 'select', default: 'expanded', store: 'prefs', options: ['expanded', 'collapsed'] },

  // Notifications
  { id: 'notifications.enabled', section: 'notifications', label: 'Enable notifications', icon: 'bell', help: 'Master switch for every alert below.', type: 'boolean', default: true, store: 'notify' },
  { id: 'notifications.macos', section: 'notifications', label: 'macOS banners', icon: 'app', help: 'System banners, sent by the Vantage server.', type: 'boolean', default: true, store: 'notify' },
  { id: 'notifications.telegram', section: 'notifications', label: 'Telegram', icon: 'link', help: 'Send alerts to a Telegram chat.', type: 'boolean', default: true, store: 'notify' },
  { id: 'notifications.push', section: 'notifications', label: 'Web Push', icon: 'globe', help: 'Background alerts delivered to this browser (even when the tab is closed).', type: 'boolean', default: true, store: 'notify', requires: 'push' },
  { id: 'notifications.telegramChatId', section: 'notifications', label: 'Telegram chat id', icon: 'key', help: 'Where Telegram messages go. Auto-detected from OpenClaw when available; otherwise paste the numeric chat id.', type: 'text', default: '', store: 'notify' },
  { id: 'notifications.diskFreePctThreshold', section: 'notifications', label: 'Low-disk threshold (%)', icon: 'disk', help: 'Notify when free disk space falls below this percentage.', type: 'number', default: 10, store: 'notify' },
  { id: 'notifications.notifyJobDone', section: 'notifications', label: 'Job finished', icon: 'check', help: 'A “job” is any long-running action, a model download, benchmark, quantize, brew install or cache prune.', type: 'boolean', default: true, store: 'notify' },
  { id: 'notifications.notifyJobFailed', section: 'notifications', label: 'Job failed', icon: 'warning', help: 'Notify when one of those jobs errors out.', type: 'boolean', default: true, store: 'notify' },
  { id: 'notifications.notifyServiceDown', section: 'notifications', label: 'Service went down', icon: 'pulse', help: 'Notify when a probed service (Ollama, ComfyUI, the gateway…) stops responding.', type: 'boolean', default: true, store: 'notify' },
  { id: 'notifications.cooldownMinutes', section: 'notifications', label: 'Repeat cooldown (minutes)', icon: 'clock', help: 'Minimum gap before the same alert fires again.', type: 'number', default: 30, store: 'notify' },

  // Behaviour (advanced)
  { id: 'behavior.wakeLock', section: 'advanced', label: 'Keep awake during jobs', icon: 'bolt', help: 'Hold a screen wake lock while actions run, so long jobs don’t sleep the display.', type: 'boolean', default: true, store: 'prefs', requires: 'wakeLock' },
  { id: 'behavior.idlePause', section: 'advanced', label: 'Pause polling when idle', icon: 'clock', help: 'Stop metric/network polling while you’re away, and resume when you return.', type: 'boolean', default: true, store: 'prefs' },
  { id: 'behavior.notifyBrowser', section: 'advanced', label: 'Browser notifications', icon: 'bell', help: 'Show alerts as browser banners while Vantage is open.', type: 'boolean', default: false, store: 'prefs', requires: 'notifications' },

  // Security (derived, driven by the WebAuthn ceremony, not a plain write)
  { id: 'security.touchId', section: 'security', label: 'Touch ID for destructive actions', icon: 'fingerprint', help: 'Require your fingerprint before irreversible actions. Verified on the server.', type: 'status', store: 'derived' },
];

const BY_ID = new Map(REGISTRY.map((entry) => [entry.id, entry]));
const prefKey = (id) => id.split('.').slice(1).join('.');

async function readPrefs() {
  try {
    const raw = JSON.parse(await fs.readFile(PREFS_FILE, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

async function writePrefs(prefs) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(PREFS_FILE, JSON.stringify(prefs, null, 2), { mode: 0o600 });
}

function coerce(entry, value) {
  if (entry.type === 'boolean') return Boolean(value);
  if (entry.type === 'number') return Number(value);
  return value == null ? '' : String(value);
}

async function values() {
  const prefs = { ...PREF_DEFAULTS, ...(await readPrefs()) };
  const settings = await notify.loadSettings();
  const out = {};
  for (const entry of REGISTRY) {
    if (entry.store === 'prefs') out[entry.id] = prefs[prefKey(entry.id)];
    else if (entry.store === 'notify') out[entry.id] = settings[prefKey(entry.id)];
  }
  return out;
}

async function patch(patchObj) {
  const prefs = { ...PREF_DEFAULTS, ...(await readPrefs()) };
  const notifyPatch = {};
  let touchedPrefs = false;
  for (const [id, value] of Object.entries(patchObj || {})) {
    const entry = BY_ID.get(id);
    if (!entry) throw Object.assign(new Error(`Unknown setting "${id}"`), { status: 400 });
    if (entry.store === 'derived') continue;
    const key = prefKey(id);
    if (entry.store === 'prefs') {
      prefs[key] = coerce(entry, value);
      touchedPrefs = true;
    } else if (entry.store === 'notify') {
      notifyPatch[key] = coerce(entry, value);
    }
  }
  if (touchedPrefs) await writePrefs(prefs);
  if (Object.keys(notifyPatch).length) await notify.saveSettings(notifyPatch);
  return values();
}

async function exportAll() {
  return {
    app: 'vantage',
    version: 1,
    exportedAt: new Date().toISOString(),
    prefs: await readPrefs(),
    notify: await notify.loadSettings(),
  };
}

async function importAll(data) {
  if (!data || typeof data !== 'object') throw Object.assign(new Error('Invalid settings file'), { status: 400 });
  if (data.prefs && typeof data.prefs === 'object') {
    const merged = { ...PREF_DEFAULTS, ...data.prefs };
    await writePrefs(merged);
  }
  if (data.notify && typeof data.notify === 'object') {
    await notify.saveSettings(data.notify);
  }
  return values();
}

async function reset(section) {
  const prefs = { ...PREF_DEFAULTS, ...(await readPrefs()) };
  const notifyDefaults = {};
  let touchedPrefs = false;
  for (const entry of REGISTRY) {
    if (section && entry.section !== section) continue;
    if (entry.store === 'derived') continue;
    if (entry.store === 'prefs') {
      prefs[prefKey(entry.id)] = entry.default;
      touchedPrefs = true;
    } else if (entry.store === 'notify') {
      notifyDefaults[prefKey(entry.id)] = entry.default;
    }
  }
  if (touchedPrefs) await writePrefs(prefs);
  if (Object.keys(notifyDefaults).length) await notify.saveSettings(notifyDefaults);
  return values();
}

function prefsInitialized() {
  return fssync.existsSync(PREFS_FILE);
}

// Remembers that the PWA was installed, so the native app / other browsers can
// report install state too.
async function markPwaInstalled() {
  const prefs = await readPrefs();
  if (!prefs.pwaInstalled) {
    prefs.pwaInstalled = true;
    await writePrefs(prefs);
  }
  return true;
}

async function pwaInstalled() {
  return Boolean((await readPrefs()).pwaInstalled);
}

module.exports = { SECTIONS, REGISTRY, values, patch, exportAll, importAll, reset, readPrefs, PREF_DEFAULTS, prefsInitialized, markPwaInstalled, pwaInstalled };
