'use strict';

// User-defined threshold rules → notifications (and optional actions).

const fs = require('node:fs/promises');
const fssync = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const FILE = path.join(__dirname, '..', 'data', 'rules.json');

let rules = null;

const METRICS = {
  diskFreePct: { label: 'Disk free', unit: '%' },
  cpu: { label: 'CPU', unit: '%' },
  memUsedPct: { label: 'Memory used', unit: '%' },
  swapUsedPct: { label: 'Swap used', unit: '%' },
  ollamaModels: { label: 'Ollama models loaded', unit: '' },
};

// Sensible starting points for a local-AI workstation.
const DEFAULTS = [
  { metric: 'diskFreePct', op: '<', threshold: 10, cooldownMinutes: 360 },
  { metric: 'diskFreePct', op: '<', threshold: 5, cooldownMinutes: 60 },
  { metric: 'memUsedPct', op: '>', threshold: 90, cooldownMinutes: 120 },
  { metric: 'swapUsedPct', op: '>', threshold: 50, cooldownMinutes: 180 },
  { metric: 'cpu', op: '>', threshold: 95, cooldownMinutes: 300 },
  { metric: 'ollamaModels', op: '>', threshold: 4, cooldownMinutes: 120 },
];

function makeRule(spec) {
  return {
    id: crypto.randomBytes(6).toString('hex'),
    metric: METRICS[spec.metric] ? spec.metric : 'diskFreePct',
    op: spec.op === '>' ? '>' : '<',
    threshold: Number(spec.threshold) || 0,
    cooldownMinutes: Number(spec.cooldownMinutes) || 60,
    notify: spec.notify !== false,
    action: spec.action || null,
    enabled: spec.enabled !== false,
    lastFired: 0,
  };
}

async function load() {
  if (rules) return rules;
  if (!fssync.existsSync(FILE)) {
    rules = DEFAULTS.map(makeRule);
    await save();
    return rules;
  }
  try {
    rules = JSON.parse(await fs.readFile(FILE, 'utf8'));
  } catch {
    rules = [];
  }
  if (!Array.isArray(rules)) rules = [];
  return rules;
}

async function save() {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(rules, null, 2));
}

async function list() {
  return (await load()).slice();
}

// Add any of the common baseline rules that aren't already present.
async function seedDefaults() {
  await load();
  let added = 0;
  for (const spec of DEFAULTS) {
    if (rules.some((r) => r.metric === spec.metric && r.op === spec.op && r.threshold === spec.threshold)) continue;
    rules.push(makeRule(spec));
    added += 1;
  }
  if (added) await save();
  return { added, rules: await list() };
}

async function upsert(patch) {
  await load();
  if (patch.id) {
    const index = rules.findIndex((r) => r.id === patch.id);
    if (index >= 0) {
      rules[index] = { ...rules[index], ...patch, id: rules[index].id };
      await save();
      return rules[index];
    }
  }
  const rule = makeRule(patch);
  rules.push(rule);
  await save();
  return rule;
}

async function remove(id) {
  await load();
  rules = rules.filter((rule) => rule.id !== id);
  await save();
}

function valueOf(metric, sample) {
  if (!sample) return null;
  if (metric === 'cpu') return sample.cpu;
  if (metric === 'diskFreePct') {
    const disk = sample.disk || {};
    return disk.total ? (disk.free / disk.total) * 100 : null;
  }
  if (metric === 'memUsedPct') {
    const mem = sample.mem || {};
    return mem.total ? (mem.used / mem.total) * 100 : null;
  }
  if (metric === 'swapUsedPct') {
    const swap = sample.swap || {};
    return swap.total ? (swap.used / swap.total) * 100 : null;
  }
  if (metric === 'ollamaModels') return sample.ollama ? sample.ollama.models : null;
  return null;
}

async function evaluate(sample, { onTrigger } = {}) {
  const active = await load();
  const fired = [];
  for (const rule of active) {
    if (!rule.enabled) continue;
    const value = valueOf(rule.metric, sample);
    if (value == null) continue;
    const hit = rule.op === '>' ? value > rule.threshold : value < rule.threshold;
    if (!hit) continue;
    if (Date.now() - (rule.lastFired || 0) < (rule.cooldownMinutes || 60) * 60_000) continue;
    rule.lastFired = Date.now();
    fired.push({ rule, value });
    if (onTrigger) {
      try {
        await onTrigger(rule, value);
      } catch {
        /* keep evaluating */
      }
    }
  }
  if (fired.length) await save();
  return fired;
}

module.exports = { list, upsert, remove, evaluate, seedDefaults, METRICS, DEFAULTS };
