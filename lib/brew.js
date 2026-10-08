'use strict';

// Rich installed-package inventory from `brew info --json=v2 --installed`,
// plus the dependency graph inverted so we can show what depends on a package.

const { run } = require('./exec');
const fssync = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const BREW = '/opt/homebrew/bin/brew';
const TTL = 60_000;
const HOME = os.homedir();

let cache = { data: null, ts: 0 };

function clearCache() {
  cache = { data: null, ts: 0 };
}

function sourceUrl(item) {
  const rubyPath = item.ruby_source_path;
  const tap = item.tap || '';
  if (!rubyPath) return null;
  let repo = null;
  if (tap === 'homebrew/core') repo = 'Homebrew/homebrew-core';
  else if (tap === 'homebrew/cask') repo = 'Homebrew/homebrew-cask';
  else if (tap.includes('/')) repo = `Homebrew/${tap.split('/')[1]}`;
  return repo ? `https://github.com/${repo}/blob/HEAD/${rubyPath}` : null;
}

function normalizeFormula(item) {
  const installed = Array.isArray(item.installed) ? item.installed[0] : null;
  return {
    name: item.name,
    kind: 'formula',
    desc: item.desc || null,
    license: item.license || null,
    homepage: item.homepage || null,
    tap: item.tap || null,
    source: sourceUrl(item),
    latest: (item.versions && item.versions.stable) || null,
    installed: installed ? installed.version : null,
    installedOn: installed && installed.time ? installed.time * 1000 : null,
    pouredFromBottle: installed ? Boolean(installed.poured_from_bottle) : false,
    reason: installed && installed.installed_on_request ? 'requested' : 'dependency',
    outdated: Boolean(item.outdated),
    pinned: Boolean(item.pinned),
    deprecated: Boolean(item.deprecated),
    deps: (item.dependencies || []).slice(0, 40),
  };
}

function resolveCaskApp(item) {
  for (const artifact of item.artifacts || []) {
    if (!artifact || !artifact.app) continue;
    const names = Array.isArray(artifact.app) ? artifact.app : [artifact.app];
    for (const name of names) {
      for (const root of ['/Applications', path.join(HOME, 'Applications')]) {
        const full = path.join(root, String(name));
        if (fssync.existsSync(full)) return full;
      }
    }
  }
  return null;
}

function normalizeCask(item) {
  const name = item.token || item.name;
  const displayName = Array.isArray(item.name) ? item.name[0] : item.name;
  return {
    name,
    displayName: displayName && displayName !== name ? displayName : null,
    kind: 'cask',
    desc: item.desc || null,
    license: item.license || null,
    homepage: item.homepage || null,
    tap: item.tap || null,
    source: sourceUrl(item),
    appPath: resolveCaskApp(item),
    latest: item.version || null,
    installed: typeof item.installed === 'string' ? item.installed : (item.installed && item.installed[0] && item.installed[0].version) || null,
    installedOn: item.installed_time ? item.installed_time * 1000 : null,
    pouredFromBottle: false,
    reason: 'requested',
    outdated: Boolean(item.outdated),
    pinned: Boolean(item.pinned),
    deprecated: Boolean(item.deprecated),
    deps: [],
  };
}

function buildDependents(list) {
  const dependents = {};
  for (const pkg of list) {
    for (const dep of pkg.deps || []) {
      (dependents[dep] = dependents[dep] || []).push(pkg.name);
    }
  }
  return dependents;
}

async function packages(force = false) {
  if (!force && cache.data && Date.now() - cache.ts < TTL) return cache.data;
  const result = await run(BREW, ['info', '--json=v2', '--installed'], { timeout: 60_000 });
  let parsed = { formulae: [], casks: [] };
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    parsed = { formulae: [], casks: [] };
  }
  const list = [...(parsed.formulae || []).map(normalizeFormula), ...(parsed.casks || []).map(normalizeCask)];
  const dependents = buildDependents(list);
  const data = {
    packages: list,
    dependents,
    counts: {
      total: list.length,
      formula: list.filter((p) => p.kind === 'formula').length,
      cask: list.filter((p) => p.kind === 'cask').length,
      outdated: list.filter((p) => p.outdated).length,
      dependencies: list.filter((p) => p.reason === 'dependency').length,
    },
    generatedAt: Date.now(),
  };
  cache = { data, ts: Date.now() };
  return data;
}

module.exports = { packages, buildDependents, normalizeFormula, normalizeCask, clearCache };
