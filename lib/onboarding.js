'use strict';

// Onboarding state, progress persists server-side so the wizard resumes across
// reloads/tabs and can be re-run from Settings → About.

const fs = require('node:fs/promises');
const path = require('node:path');

const DATA_DIR = process.env.VANTAGE_DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'onboarding.json');

const VERSION = 1;
const DEFAULT = { version: VERSION, startedAt: null, completedAt: null, currentStep: 0, steps: {}, skipped: [] };

async function read() {
  try {
    const raw = JSON.parse(await fs.readFile(FILE, 'utf8'));
    return { ...DEFAULT, ...(raw && typeof raw === 'object' ? raw : {}) };
  } catch {
    return { ...DEFAULT };
  }
}

async function write(state) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

async function get() {
  return read();
}

async function update(patch) {
  const current = await read();
  const next = {
    ...current,
    ...patch,
    steps: { ...current.steps, ...(patch && patch.steps ? patch.steps : {}) },
  };
  if (!current.startedAt && !patch.completedAt) next.startedAt = new Date().toISOString();
  await write(next);
  return next;
}

async function reset() {
  const fresh = { ...DEFAULT };
  await write(fresh);
  return fresh;
}

module.exports = { get, update, reset, VERSION };
