'use strict';

// Rich metadata for installed language packages (pip + npm), combining local
// install info with registry info (latest version, description).

const path = require('node:path');

const { run, readJsonSafe } = require('./exec');

const PY = { '3.14': '/opt/homebrew/bin/python3.14', '3.12': '/opt/homebrew/bin/python3.12' };

async function fetchJson(url, timeout = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function pythonDetail(name, label) {
  const bin = PY[label] || PY['3.14'];
  const result = await run(bin, ['-m', 'pip', 'show', '-f', name], { timeout: 25_000 });
  const out = result.stdout || '';
  const grab = (key) => {
    const match = out.match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'));
    return match ? match[1].trim() : null;
  };
  const listOf = (key) => {
    const value = grab(key);
    return value ? value.split(',').map((part) => part.trim()).filter(Boolean) : [];
  };

  let fileCount = null;
  const filesIdx = out.indexOf('\nFiles:');
  if (filesIdx >= 0) fileCount = out.slice(filesIdx).split('\n').slice(1).filter((line) => line.trim()).length;

  const pypi = await fetchJson(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`);
  const pypiInfo = pypi && pypi.info ? pypi.info : null;
  const installed = grab('Version');

  return {
    name: grab('Name') || name,
    version: installed,
    interpreter: bin,
    interpreterLabel: label || null,
    summary: grab('Summary') || (pypiInfo && pypiInfo.summary) || null,
    homepage: grab('Home-page') || (pypiInfo && pypiInfo.home_page) || null,
    author: grab('Author') || (pypiInfo && pypiInfo.author) || grab('Author-email') || null,
    license: grab('License') || (pypiInfo && pypiInfo.license) || null,
    location: grab('Location') || null,
    requires: listOf('Requires'),
    requiredBy: listOf('Required-by'),
    fileCount,
    latest: pypiInfo ? pypiInfo.version : null,
    latestSummary: pypiInfo ? pypiInfo.summary : null,
    requiresPython: pypiInfo ? pypiInfo.requires_python : null,
    pypiUrl: pypiInfo ? pypiInfo.package_url || `https://pypi.org/project/${name}/` : `https://pypi.org/project/${name}/`,
    outdated: Boolean(installed && pypiInfo && pypiInfo.version && pypiInfo.version !== installed),
  };
}

async function npmDetail(name) {
  const root = await run('npm', ['root', '-g'], { timeout: 20_000 });
  const globalRoot = root.ok ? root.stdout.trim() : null;
  const local = globalRoot ? await readJsonSafe(path.join(globalRoot, name, 'package.json')) : null;

  const registry = await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(name)}`);
  const latest = registry && registry['dist-tags'] ? registry['dist-tags'].latest : null;
  const latestManifest = registry && latest && registry.versions ? registry.versions[latest] : null;

  let binNames = [];
  if (local && local.bin) binNames = typeof local.bin === 'string' ? [name.split('/').pop()] : Object.keys(local.bin);

  return {
    name,
    version: local ? local.version : null,
    description: (local && local.description) || (latestManifest && latestManifest.description) || null,
    homepage: (local && (local.homepage || (local.repository && local.repository.url))) || (latestManifest && latestManifest.homepage) || (registry && registry.homepage) || null,
    license: (local && local.license) || (latestManifest && latestManifest.license) || null,
    dependencies: local && local.dependencies ? Object.keys(local.dependencies).length : latestManifest && latestManifest.dependencies ? Object.keys(latestManifest.dependencies).length : 0,
    binNames,
    path: globalRoot ? path.join(globalRoot, name) : null,
    latest,
    npmUrl: `https://www.npmjs.com/package/${name}`,
    outdated: Boolean(local && local.version && latest && latest !== local.version),
  };
}

function clearOutdatedCache() {
  outdatedCache = { ts: 0, data: null };
}

async function pipOutdated(label) {
  const bin = PY[label] || PY['3.14'];
  const result = await run(bin, ['-m', 'pip', 'list', '--outdated', '--format=json'], { timeout: 120_000 });
  if (!result.ok) {
    const detail = (result.stderr || '').trim().split('\n').filter(Boolean).pop();
    return { available: false, error: detail || result.error || 'pip check failed', packages: [] };
  }
  let list = [];
  try {
    list = JSON.parse(result.stdout || '[]');
  } catch {
    list = [];
  }
  return { available: true, packages: list.map((item) => ({ name: item.name, version: item.version, latest: item.latest_version })) };
}

async function npmOutdated() {
  const result = await run('npm', ['outdated', '-g', '--json'], { timeout: 120_000 });
  let data = null;
  try {
    data = JSON.parse(result.stdout || '{}');
  } catch {
    data = null;
  }
  const packages = data ? Object.entries(data).map(([name, info]) => ({ name, version: info.current || null, latest: info.latest || null })) : [];
  return { available: Boolean(data), packages };
}

let outdatedCache = { ts: 0, data: null };

async function outdated(force = false) {
  if (!force && outdatedCache.data && Date.now() - outdatedCache.ts < 5 * 60_000) return outdatedCache.data;
  const [p14, p12, npm] = await Promise.all([pipOutdated('3.14'), pipOutdated('3.12'), npmOutdated()]);
  const data = {
    python: { '3.14': p14, '3.12': p12 },
    npm,
    total: p14.packages.length + p12.packages.length + npm.packages.length,
    checkedAt: Date.now(),
  };
  outdatedCache = { ts: Date.now(), data };
  return data;
}

module.exports = { pythonDetail, npmDetail, pipOutdated, npmOutdated, outdated, clearOutdatedCache };
