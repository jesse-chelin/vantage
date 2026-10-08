'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');

const { insights } = require('../lib/models');
const { summarize } = require('../lib/safetensors');
const { normalizeFormula, normalizeCask, buildDependents } = require('../lib/brew');
const cache = require('../lib/cache');

test('models.insights marks unused models and avoids double-counting shared blobs', () => {
  const inventory = {
    ollama: {
      models: [
        { name: 'used:latest', sizeBytes: 10, digest: 'aaa', capabilities: [] },
        { name: 'cold:latest', sizeBytes: 30, digest: 'bbb', capabilities: [] },
        { name: 'twin:latest', sizeBytes: 20, digest: 'ccc', capabilities: [] },
        { name: 'twin:other', sizeBytes: 20, digest: 'ccc', capabilities: [] },
      ],
    },
    agentStack: { openclaw: { primaryModel: 'ollama/used' } },
  };
  const usage = { 'used:latest': { lastLoaded: Date.now(), loads: 3 } };
  const result = insights(inventory, usage);

  const byName = Object.fromEntries(result.models.map((m) => [m.name, m]));
  assert.equal(byName['used:latest'].used, true, 'agent-routed model is in use');
  assert.equal(byName['cold:latest'].recommended, true, 'unused single-tag model is recommended');
  assert.equal(byName['cold:latest'].freesIfDeleted, 30);
  assert.equal(byName['twin:latest'].shared, true, 'shared digest is flagged');
  assert.equal(byName['twin:latest'].freesIfDeleted, 0, 'a shared tag frees nothing alone');
  // cold (30) + both twins (20 each) fully removed = 50; used is excluded.
  assert.equal(result.totalReclaimableBytes, 50);
  assert.equal(result.recommended.length, 3);
});

test('safetensors.summarize reads header without loading weights', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-'));
  const file = path.join(dir, 'tiny.safetensors');
  const header = {
    __metadata__: { format: 'pt' },
    'layer.weight': { dtype: 'F16', shape: [2, 3], data_offsets: [0, 12] },
  };
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(json.length), 0);
  await fs.writeFile(file, Buffer.concat([length, json, Buffer.alloc(12)]));

  const result = await summarize(file);
  assert.ok(result, 'header parsed');
  assert.equal(result.tensors, 1);
  assert.equal(result.params, 6);
  assert.equal(result.bytes, 12);
  assert.deepEqual(Object.keys(result.dtypes), ['F16']);
  assert.equal(result.metadata.format, 'pt');

  await fs.rm(dir, { recursive: true, force: true });
});

test('cache.memo dedupes concurrent calls and honours TTL', async () => {
  let calls = 0;
  const factory = () => new Promise((resolve) => setTimeout(() => resolve(++calls), 20));
  const [a, b] = await Promise.all([cache.memo('k1', 1000, factory), cache.memo('k1', 1000, factory)]);
  assert.equal(a, b, 'concurrent callers share one result');
  assert.equal(calls, 1, 'factory ran once');
  const c = await cache.memo('k1', 1000, factory);
  assert.equal(c, a, 'cached value reused');
  assert.equal(calls, 1);
  cache.clear();
});

test('brew normalizers map formulae and casks, and invert dependencies', () => {
  const formula = normalizeFormula({
    name: 'node',
    desc: 'JavaScript runtime',
    license: 'MIT',
    homepage: 'https://nodejs.org/',
    tap: 'homebrew/core',
    ruby_source_path: 'Formula/n/node.rb',
    versions: { stable: '23.0.0' },
    dependencies: ['abseil', 'openssl@3'],
    installed: [{ version: '22.9.0_1', time: 1700000000, installed_on_request: true, poured_from_bottle: true }],
    outdated: true,
    pinned: false,
  });
  assert.equal(formula.kind, 'formula');
  assert.equal(formula.reason, 'requested');
  assert.equal(formula.latest, '23.0.0');
  assert.equal(formula.installed, '22.9.0_1');
  assert.equal(formula.installedOn, 1700000000 * 1000);
  assert.equal(formula.outdated, true);
  assert.equal(formula.pouredFromBottle, true);
  assert.match(formula.source, /homebrew-core\/blob\/HEAD\/Formula\/n\/node\.rb$/);
  assert.deepEqual(formula.deps, ['abseil', 'openssl@3']);

  const dependency = normalizeFormula({ name: 'abseil', versions: { stable: '1' }, installed: [{ version: '1', installed_on_request: false }] });
  assert.equal(dependency.reason, 'dependency');

  const cask = normalizeCask({ token: 'ghostty', name: ['Ghostty'], version: '1.3.1', installed: '1.3.1', installed_time: 1700000000, tap: 'homebrew/cask', ruby_source_path: 'Casks/g/ghostty.rb' });
  assert.equal(cask.name, 'ghostty');
  assert.equal(cask.displayName, 'Ghostty');
  assert.equal(cask.kind, 'cask');
  assert.equal(cask.installed, '1.3.1');
  assert.equal(cask.installedOn, 1700000000 * 1000);
  assert.match(cask.source, /homebrew-cask\/blob\/HEAD\/Casks\/g\/ghostty\.rb$/);

  const dependents = buildDependents([formula, dependency]);
  assert.deepEqual(dependents['abseil'], ['node']);
  assert.deepEqual(dependents['openssl@3'], ['node']);
});

test('app icon pipeline rejects non-app paths and extracts a PNG', async (t) => {
  const { appIcon } = require('../lib/icons');
  await assert.rejects(() => appIcon('/etc/passwd', 64), /application/i);
  let dir = '/Applications';
  try {
    await fs.access(dir);
  } catch {
    return t.skip('no /Applications on this host');
  }
  const app = (await fs.readdir(dir)).find((name) => name.endsWith('.app'));
  if (!app) return t.skip('no app bundles');
  const file = await appIcon(path.join(dir, app), 64);
  if (file) {
    assert.ok(file.endsWith('.png'));
    await fs.access(file);
  } else {
    t.diagnostic(`no extractable icon for ${app}`);
  }
});
