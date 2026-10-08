'use strict';

// Scheduled actions & digests. Evaluated on a timer; each entry runs an action
// (via the action registry) or sends a digest notification.

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const FILE = path.join(__dirname, '..', 'data', 'schedule.json');

let tasks = null;

async function load() {
  if (tasks) return tasks;
  try {
    tasks = JSON.parse(await fs.readFile(FILE, 'utf8'));
  } catch {
    tasks = [];
  }
  if (!Array.isArray(tasks)) tasks = [];
  return tasks;
}

async function save() {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(tasks, null, 2));
}

async function list() {
  return (await load()).slice();
}

function normalizeCadence(cadence) {
  const c = cadence || {};
  if (c.type === 'interval') return { type: 'interval', minutes: Math.max(5, Number(c.minutes) || 60) };
  if (c.type === 'weekly') return { type: 'weekly', weekday: Number(c.weekday) || 0, time: c.time || '03:00' };
  return { type: 'daily', time: c.time || '03:00' };
}

async function upsert(patch) {
  await load();
  if (patch.id) {
    const index = tasks.findIndex((t) => t.id === patch.id);
    if (index >= 0) {
      const next = { ...tasks[index], ...patch, id: tasks[index].id };
      if (patch.cadence) next.cadence = normalizeCadence(patch.cadence);
      tasks[index] = next;
      await save();
      return next;
    }
  }
  const task = {
    id: crypto.randomBytes(6).toString('hex'),
    kind: patch.kind === 'digest' ? 'digest' : 'action',
    action: patch.action || 'system.cleanAll',
    params: patch.params || {},
    cadence: normalizeCadence(patch.cadence),
    label: patch.label || null,
    enabled: patch.enabled !== false,
    lastRun: 0,
  };
  tasks.push(task);
  await save();
  return task;
}

async function remove(id) {
  await load();
  tasks = tasks.filter((task) => task.id !== id);
  await save();
}

function due(task, now) {
  const cadence = task.cadence || {};
  const last = task.lastRun || 0;
  if (cadence.type === 'interval') return now - last >= (cadence.minutes || 60) * 60_000;
  const [hours, minutes] = String(cadence.time || '03:00').split(':').map(Number);
  const today = new Date(now);
  today.setHours(hours || 3, minutes || 0, 0, 0);
  if (cadence.type === 'weekly' && today.getDay() !== (cadence.weekday ?? 0)) return false;
  if (now < today.getTime()) return false;
  return last < today.getTime();
}

async function runDue({ onAction, onDigest, now = Date.now() } = {}) {
  const all = await load();
  const ran = [];
  for (const task of all) {
    if (!task.enabled || !due(task, now)) continue;
    task.lastRun = now;
    ran.push(task);
    try {
      if (task.kind === 'digest' && onDigest) await onDigest(task);
      else if (task.kind === 'action' && onAction) await onAction(task);
    } catch {
      /* keep going */
    }
  }
  if (ran.length) await save();
  return ran;
}

module.exports = { list, upsert, remove, runDue };
