'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');

const PORT = 8792;
const BASE = `http://127.0.0.1:${PORT}`;
let child;

async function waitForHealth(timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

test.before(async () => {
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
    stdio: 'ignore',
  });
  assert.ok(await waitForHealth(), 'server should start and answer /api/health');
});

test.after(() => {
  if (child) child.kill('SIGKILL');
});

test('health and inventory respond', async () => {
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
  assert.equal(health.ok, true);
  const inventory = await fetch(`${BASE}/api/inventory`).then((r) => r.json());
  assert.ok('data' in inventory);
});

test('actions and history are listed', async () => {
  const actions = await fetch(`${BASE}/api/actions`).then((r) => r.json());
  assert.ok(Array.isArray(actions.actions) && actions.actions.length > 10, 'expected many actions');
  const history = await fetch(`${BASE}/api/history`).then((r) => r.json());
  assert.ok(Array.isArray(history.actions), 'history has an actions array');
});

test('mutations are rejected without the token', async () => {
  assert.equal((await fetch(`${BASE}/api/scan`, { method: 'POST' })).status, 403);
  assert.equal((await fetch(`${BASE}/api/undo/1`, { method: 'POST' })).status, 403);
  const load = await fetch(`${BASE}/api/actions/ollama.load`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(load.status, 403);
});

test('a valid token is accepted', async () => {
  const { token } = await fetch(`${BASE}/api/session`).then((r) => r.json());
  const response = await fetch(`${BASE}/api/scan`, { method: 'POST', headers: { 'x-dashboard-token': token } });
  assert.ok([200, 202].includes(response.status), `expected 2xx, got ${response.status}`);
});

test('homebrew inventory exposes rich packages', async () => {
  const { packages, counts } = await fetch(`${BASE}/api/brew/packages`).then((r) => r.json());
  assert.ok(Array.isArray(packages), 'packages is an array');
  assert.equal(typeof counts.total, 'number');
  if (packages.length) {
    const sample = packages[0];
    assert.ok(['formula', 'cask'].includes(sample.kind));
    assert.ok('reason' in sample && 'installed' in sample);
  }
});
