'use strict';

// Frontier AI cloud spend, starting with DeepSeek.
//
// Two sources, both stored locally in data/spend.json:
//   - a manual ledger you can add to from the dashboard (top-ups and usage), and
//   - live balance samples pulled from the DeepSeek API when a key is set.
// Spend is derived from the drops between balance samples (top-ups are ignored);
// when no samples exist yet the manual ledger is used instead.
//
// The server samples the balance on a schedule so tracking continues with the
// dashboard closed, derives a burn rate/projection, and raises budget / low
// balance / top-up / spike alerts through an injected notifier (see setNotifier).
//
// The API key never leaves the machine except to call DeepSeek, and it is never
// returned to the browser, only a masked hint.

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA_DIR = process.env.VANTAGE_DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'spend.json');

const API_BASE = (process.env.DEEPSEEK_API_BASE || 'https://api.deepseek.com').replace(/\/+$/, '');
const SAMPLE_LIMIT = 4000;
const ENTRY_LIMIT = 5000;
const DAY = 86_400_000;
const SAMPLE_GAP_MS = 30 * 60 * 1000; // don't sample the API more often than this
const STALE_MS = 6 * 60 * 60 * 1000; // the dashboard treats older samples as stale
const RETENTION_MS = 90 * DAY; // balance history window

const PROVIDERS = {
  deepseek: { id: 'deepseek', label: 'DeepSeek', currency: 'USD' },
};

const CONFIG_DEFAULTS = {
  budget: 0,
  budgetWarnPct: 80,
  lowBalance: 0,
  alerts: { budget: true, lowBalance: true, topup: true, spike: true, error: true },
};

// Injected by the server so alerts use the real notification channels. Left null
// in unit tests (and any embedding) so nothing is sent by accident.
let notifier = null;
function setNotifier(fn) {
  notifier = typeof fn === 'function' ? fn : null;
}
async function emit(key, title, body) {
  if (!notifier) return;
  try {
    await notifier(key, title, body);
  } catch {
    /* notifications are best-effort */
  }
}

function httpError(message, status) {
  return Object.assign(new Error(message), { status });
}

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function cleanSample(sample) {
  const ts = asNumber(sample && sample.ts);
  const total = asNumber(sample && sample.total);
  if (ts == null || total == null) return null;
  return { ts: Math.round(ts), total: round2(total), currency: String((sample && sample.currency) || 'USD') };
}

function cleanEntry(entry) {
  const amount = asNumber(entry && entry.amount);
  const ts = asNumber(entry && entry.ts);
  if (!entry || typeof entry.id !== 'string' || amount == null || ts == null) return null;
  return {
    id: entry.id,
    ts: Math.round(ts),
    amount: round2(amount),
    kind: entry.kind === 'topup' ? 'topup' : 'usage',
    note: entry.note ? String(entry.note).slice(0, 200) : null,
  };
}

function normalizeSamples(samples, now = Date.now()) {
  const list = (Array.isArray(samples) ? samples : [])
    .map(cleanSample)
    .filter(Boolean)
    .sort((a, b) => a.ts - b.ts);
  const kept = list.filter((sample) => sample.ts >= now - RETENTION_MS);
  const bounded = (kept.length ? kept : list.slice(-1)).slice(-SAMPLE_LIMIT);
  return bounded;
}

function normalizeEntries(entries) {
  return (Array.isArray(entries) ? entries : [])
    .map(cleanEntry)
    .filter(Boolean)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, ENTRY_LIMIT);
}

function normalizeConfig(raw) {
  const config = raw && typeof raw === 'object' ? raw : {};
  const alerts = config.alerts && typeof config.alerts === 'object' ? config.alerts : {};
  const warn = asNumber(config.budgetWarnPct);
  return {
    budget: Math.max(0, asNumber(config.budget) || 0),
    budgetWarnPct: Math.min(100, Math.max(1, warn == null ? CONFIG_DEFAULTS.budgetWarnPct : warn)),
    lowBalance: Math.max(0, asNumber(config.lowBalance) || 0),
    alerts: {
      budget: alerts.budget !== false,
      lowBalance: alerts.lowBalance !== false,
      topup: alerts.topup !== false,
      spike: alerts.spike !== false,
      error: alerts.error !== false,
    },
  };
}

async function load() {
  let raw = null;
  try {
    raw = JSON.parse(await fs.readFile(FILE, 'utf8'));
  } catch {
    raw = null;
  }
  const state = raw && typeof raw === 'object' ? raw : {};
  return {
    provider: PROVIDERS[state.provider] ? state.provider : 'deepseek',
    apiKey: typeof state.apiKey === 'string' && state.apiKey ? state.apiKey : null,
    config: normalizeConfig(state.config),
    samples: normalizeSamples(state.samples),
    entries: normalizeEntries(state.entries),
    sampledAt: asNumber(state.sampledAt),
    lastError: typeof state.lastError === 'string' && state.lastError ? state.lastError : null,
  };
}

async function save(state) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const out = {
    provider: state.provider || 'deepseek',
    apiKey: state.apiKey || null,
    config: state.config || CONFIG_DEFAULTS,
    sampledAt: state.sampledAt || null,
    lastError: state.lastError || null,
    samples: normalizeSamples(state.samples),
    entries: normalizeEntries(state.entries),
  };
  await fs.writeFile(FILE, JSON.stringify(out, null, 2), { mode: 0o600 });
}

function maskKey(key) {
  const value = String(key || '');
  if (value.length <= 4) return '••••';
  return `••••${value.slice(-4)}`;
}

// Walk the balance series and total up the drops (spend). Rises are top-ups and
// increase the top-up total instead.
function deriveSpend(samples) {
  const buckets = { today: 0, week: 0, month: 0, total: 0, topups: 0 };
  if (!samples || samples.length < 2) return buckets;
  const now = Date.now();
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  for (let i = 1; i < samples.length; i += 1) {
    const delta = round2(samples[i - 1].total - samples[i].total);
    if (delta === 0) continue;
    if (delta > 0) {
      buckets.total += delta;
      if (samples[i].ts >= dayStart.getTime()) buckets.today += delta;
      if (samples[i].ts >= now - 7 * DAY) buckets.week += delta;
      if (samples[i].ts >= now - 30 * DAY) buckets.month += delta;
    } else {
      buckets.topups += -delta;
    }
  }
  return round(buckets);
}

function deriveLedger(entries) {
  const usage = { today: 0, week: 0, month: 0, total: 0 };
  const topups = { today: 0, week: 0, month: 0, total: 0 };
  const now = Date.now();
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  for (const entry of entries) {
    const target = entry.kind === 'topup' ? topups : usage;
    target.total += entry.amount;
    if (entry.ts >= now - 7 * DAY) target.week += entry.amount;
    if (entry.ts >= now - 30 * DAY) target.month += entry.amount;
    if (entry.ts >= dayStart.getTime()) target.today += entry.amount;
  }
  return { usage: round(usage), topups: round(topups) };
}

function round(buckets) {
  const out = {};
  for (const [key, value] of Object.entries(buckets)) out[key] = round2(value);
  return out;
}

// Burn rate + month projection from the same source as the spend figures.
function deriveBurn(samples, spend, source) {
  const now = Date.now();
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const nextMonth = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 1);
  const daysLeftInMonth = Math.max(0, Math.ceil((nextMonth.getTime() - now) / DAY));

  let perDay = 0;
  let basis = 'this month';
  if (source === 'api' && samples.length >= 2) {
    const week = samples.filter((sample) => sample.ts >= now - 7 * DAY);
    if (week.length >= 2) {
      const span = Math.max((week[week.length - 1].ts - week[0].ts) / DAY, 1 / 24);
      perDay = spend.week / span;
      basis = 'last 7 days';
    } else {
      const span = Math.max((samples[samples.length - 1].ts - samples[0].ts) / DAY, 1 / 24);
      perDay = spend.total / span;
      basis = `last ${span.toFixed(1)} days`;
    }
  } else {
    const elapsed = Math.max((now - monthStart.getTime()) / DAY, 1 / 24);
    perDay = spend.total / elapsed;
    basis = 'this month';
  }

  perDay = round2(perDay);
  return {
    perDay,
    basis,
    projectedMonth: round2(spend.month + perDay * daysLeftInMonth),
    daysLeftInMonth,
  };
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Daily gross spend keyed by local calendar day.
function dailyDrops(samples) {
  const byDay = new Map();
  for (let i = 1; i < samples.length; i += 1) {
    const delta = round2(samples[i - 1].total - samples[i].total);
    if (delta <= 0) continue;
    const day = new Date(samples[i].ts).toDateString();
    byDay.set(day, round2((byDay.get(day) || 0) + delta));
  }
  return byDay;
}

function reportFrom(state) {
  const samples = state.samples;
  const latest = samples[samples.length - 1] || null;
  const currency = latest ? latest.currency : PROVIDERS.deepseek.currency;
  const apiSpend = deriveSpend(samples);
  const ledger = deriveLedger(state.entries);
  const hasSamples = samples.length >= 2;
  // Once a key is connected, report the live source even before a second sample
  // lands, so totals read "from balance history" (0 until history builds).
  const useApi = hasSamples || Boolean(state.apiKey);
  const spend = useApi
    ? { source: 'api', currency, ...apiSpend }
    : { source: 'ledger', currency, today: ledger.usage.today, week: ledger.usage.week, month: ledger.usage.month, total: ledger.usage.total, topups: ledger.topups.total };
  const burn = deriveBurn(samples, spend, spend.source);
  if (latest && latest.total > 0 && burn.perDay > 0) burn.balanceDays = Math.round((latest.total / burn.perDay) * 10) / 10;
  const stale = Boolean(state.apiKey) && (!state.sampledAt || Date.now() - state.sampledAt > STALE_MS);
  return {
    provider: 'deepseek',
    providerLabel: PROVIDERS.deepseek.label,
    connected: Boolean(state.apiKey),
    keyHint: state.apiKey ? maskKey(state.apiKey) : null,
    currency,
    balance: latest ? latest.total : null,
    sampledAt: state.sampledAt,
    lastError: state.lastError,
    stale,
    hasSamples,
    sampleCount: samples.length,
    balanceSeries: samples.map((sample) => ({ ts: sample.ts, total: sample.total })),
    spend,
    burn,
    config: state.config,
    ledger: {
      count: state.entries.length,
      entries: state.entries,
      total: ledger.usage.total,
      topups: ledger.topups.total,
    },
    updatedAt: Date.now(),
  };
}

async function report() {
  return reportFrom(await load());
}

async function fetchBalance(key) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  let response;
  try {
    response = await fetch(`${API_BASE}/user/balance`, {
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      signal: controller.signal,
    });
  } catch (error) {
    throw httpError(`Could not reach DeepSeek: ${error.name === 'AbortError' ? 'timed out' : error.message}`, 502);
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 401 || response.status === 403) throw httpError('DeepSeek rejected the API key', 400);
  if (!response.ok) throw httpError(`DeepSeek returned HTTP ${response.status}`, 502);
  let data;
  try {
    data = await response.json();
  } catch {
    throw httpError('DeepSeek returned an unreadable response', 502);
  }
  const info = Array.isArray(data && data.balance_infos) ? data.balance_infos[0] : null;
  const total = asNumber(info && info.total_balance);
  if (!info || total == null) throw httpError('DeepSeek returned no balance information', 502);
  return { total: round2(total), currency: String(info.currency || PROVIDERS.deepseek.currency) };
}

async function emitErrorAlert(message) {
  await emit(`spend:error:${new Date().toISOString().slice(0, 10)}`, 'DeepSeek connection problem', message);
}

async function evaluateAlerts(state, data, prevSample) {
  const config = state.config;
  if (!config) return;
  const alerts = config.alerts || {};
  const amount = (value) => `${round2(value).toFixed(2)} ${data.currency}`;
  const stamp = new Date().toISOString().slice(0, 10);
  const month = new Date().toISOString().slice(0, 7);

  if (alerts.budget && config.budget > 0) {
    const spent = data.spend.month;
    if (spent >= config.budget) {
      await emit(`spend:budget:${month}`, 'DeepSeek budget reached', `You have spent ${amount(spent)} of your ${amount(config.budget)} monthly budget.`);
    } else if (spent >= config.budget * (config.budgetWarnPct / 100)) {
      const pct = Math.round((spent / config.budget) * 100);
      await emit(`spend:budgetwarn:${month}`, 'DeepSeek budget warning', `${pct}% of your ${amount(config.budget)} monthly budget spent (${amount(spent)}).`);
    }
  }

  if (alerts.lowBalance && config.lowBalance > 0 && data.balance != null && data.balance <= config.lowBalance) {
    await emit(`spend:lowbalance:${stamp}`, 'DeepSeek balance low', `Balance is ${amount(data.balance)} (floor ${amount(config.lowBalance)}). Top up to keep API calls working.`);
  }

  if (alerts.topup && prevSample && data.balance != null && data.balance > prevSample.total + 0.005) {
    await emit(`spend:topup:${stamp}`, 'DeepSeek top-up detected', `Balance rose to ${amount(data.balance)} (+${amount(data.balance - prevSample.total)}).`);
  }

  if (alerts.spike && data.spend.source === 'api') {
    const byDay = dailyDrops(state.samples);
    const today = new Date().toDateString();
    const todaySpend = byDay.get(today) || 0;
    const history = [...byDay.entries()].filter(([day]) => day !== today).map(([, value]) => value);
    const typical = median(history);
    if (todaySpend > 1 && history.length >= 3 && todaySpend > typical * 3) {
      await emit(`spend:spike:${stamp}`, 'DeepSeek spend spike', `Today's spend is ${amount(todaySpend)}, well above your typical ${amount(typical)}.`);
    }
  }
}

// Pull a fresh balance and append it to the history. `force` records a sample
// even within the min gap (used by the dashboard's explicit Refresh). Records
// the last error so the UI can show why the connection is unhealthy.
async function sample(force = false) {
  const state = await load();
  if (!state.apiKey) throw httpError('No DeepSeek API key configured', 400);
  const prevSample = state.samples[state.samples.length - 1] || null;
  try {
    const { total, currency } = await fetchBalance(state.apiKey);
    const now = Date.now();
    const withinGap = prevSample && now - prevSample.ts < SAMPLE_GAP_MS;
    if (force || !withinGap || prevSample.total !== total) {
      state.samples = normalizeSamples([...state.samples, { ts: now, total, currency }], now);
    }
    state.sampledAt = now;
    state.lastError = null;
    await save(state);
    const data = reportFrom(state);
    await evaluateAlerts(state, data, prevSample);
    return data;
  } catch (error) {
    state.lastError = error.message;
    await save(state);
    if (error.status === 400 && state.config.alerts.error) await emitErrorAlert(error.message);
    throw error;
  }
}

async function refresh(options = {}) {
  return sample(options === true || (options && options.force) === true);
}

// Best-effort sampler for the periodic server timer and view loads: only polls
// when a key is set and the last sample is older than the gap, and never throws.
async function sampleIfDue() {
  const state = await load();
  if (!state.apiKey) return null;
  if (state.sampledAt && Date.now() - state.sampledAt < SAMPLE_GAP_MS) return null;
  return sample(false).catch(() => null);
}

async function config() {
  const state = await load();
  return { provider: 'deepseek', providerLabel: PROVIDERS.deepseek.label, connected: Boolean(state.apiKey), keyHint: state.apiKey ? maskKey(state.apiKey) : null };
}

async function setKey(key) {
  const value = String(key || '').trim();
  if (!value) throw httpError('Enter a DeepSeek API key', 400);
  const state = await load();
  state.apiKey = value;
  state.lastError = null;
  await save(state);
  return config();
}

async function clearKey() {
  const state = await load();
  state.apiKey = null;
  state.lastError = null;
  await save(state);
  return config();
}

async function setConfig(patch) {
  const state = await load();
  const incoming = patch && typeof patch === 'object' ? patch : {};
  const merged = { ...state.config, ...incoming };
  if (incoming.alerts && typeof incoming.alerts === 'object') merged.alerts = { ...state.config.alerts, ...incoming.alerts };
  state.config = normalizeConfig(merged);
  await save(state);
  return reportFrom(state);
}

async function addEntry(input) {
  const amount = asNumber(input && input.amount);
  if (amount == null || amount <= 0) throw httpError('Enter an amount above zero', 400);
  const state = await load();
  const entry = {
    id: crypto.randomBytes(6).toString('hex'),
    ts: asNumber(input && input.ts) || Date.now(),
    amount: round2(amount),
    kind: input && input.kind === 'topup' ? 'topup' : 'usage',
    note: input && input.note ? String(input.note).slice(0, 200) : null,
  };
  state.entries = normalizeEntries([...state.entries, entry]);
  await save(state);
  return reportFrom(state);
}

async function removeEntry(id) {
  const state = await load();
  const next = state.entries.filter((entry) => entry.id !== id);
  if (next.length === state.entries.length) throw httpError('No such ledger entry', 404);
  state.entries = next;
  await save(state);
  return reportFrom(state);
}

module.exports = {
  report,
  refresh,
  sample,
  sampleIfDue,
  maybeSample: sampleIfDue,
  config,
  setKey,
  clearKey,
  setConfig,
  addEntry,
  removeEntry,
  setNotifier,
  evaluateAlerts,
  deriveSpend,
  deriveLedger,
  deriveBurn,
  normalizeConfig,
  CONFIG_DEFAULTS,
  SAMPLE_GAP_MS,
  STALE_MS,
  RETENTION_MS,
  FILE,
};
