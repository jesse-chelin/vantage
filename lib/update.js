'use strict';

// In-app update checking and updating, backed by the local git checkout.
// Everything is best-effort: a missing checkout or a failed fetch resolves to a
// status object rather than throwing.

const fs = require('node:fs');
const path = require('node:path');
const { run } = require('./exec');

const ROOT = path.join(__dirname, '..');
const VERSION = (() => {
  try { return require('../package.json').version || '0.0.0'; } catch { return '0.0.0'; }
})();

function git(args, timeout = 20_000) {
  return run('/usr/bin/git', ['-C', ROOT, ...args], { timeout });
}

async function status() {
  if (!fs.existsSync(path.join(ROOT, '.git'))) {
    return { supported: false, available: false, version: VERSION, reason: 'Not a git checkout' };
  }

  const fetch = await git(['fetch', '--quiet', '--prune'], 30_000);

  const current = (await git(['rev-parse', 'HEAD'])).stdout.trim();

  let upstreamRef = (await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).stdout.trim();
  if (!upstreamRef) {
    for (const candidate of ['origin/main', 'origin/master']) {
      if ((await git(['rev-parse', '--verify', '--quiet', candidate])).ok) { upstreamRef = candidate; break; }
    }
  }
  if (!upstreamRef) {
    return { supported: true, available: false, version: VERSION, current: current.slice(0, 7), reason: 'No upstream branch', fetched: fetch.ok };
  }

  const upstream = (await git(['rev-parse', '--verify', '--quiet', upstreamRef])).stdout.trim();
  if (!upstream) {
    return { supported: true, available: false, version: VERSION, current: current.slice(0, 7), upstream: upstreamRef, reason: 'Upstream not fetched', fetched: fetch.ok };
  }

  const behind = Number((await git(['rev-list', '--count', `${current}..${upstream}`])).stdout.trim()) || 0;
  const ahead = Number((await git(['rev-list', '--count', `${upstream}..${current}`])).stdout.trim()) || 0;
  const subject = (await git(['log', '-1', '--format=%s', upstream])).stdout.trim();
  const date = (await git(['log', '-1', '--format=%cI', upstream])).stdout.trim();

  return {
    supported: true,
    available: behind > 0,
    version: VERSION,
    behind,
    ahead,
    current: current.slice(0, 7),
    latest: upstream.slice(0, 7),
    upstream: upstreamRef,
    subject,
    date,
    fetched: fetch.ok,
    error: fetch.ok ? null : (fetch.stderr || fetch.error || 'fetch failed').trim().slice(0, 200),
  };
}

async function apply(options = {}) {
  if (!fs.existsSync(path.join(ROOT, '.git'))) {
    throw Object.assign(new Error('This install is not a git checkout, so it cannot self-update.'), { status: 400 });
  }

  const before = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  const pull = await git(['pull', '--ff-only'], 120_000);
  if (!pull.ok) {
    const message = (pull.stderr || pull.stdout || pull.error || 'git pull failed').trim().slice(0, 300);
    throw Object.assign(new Error(message), { status: 500 });
  }
  const after = (await git(['rev-parse', 'HEAD'])).stdout.trim();

  // Refresh dependencies whenever the manifest or lockfile changed.
  let depsChanged = false;
  if (before !== after) {
    const changed = await git(['diff', '--name-only', before, after], 20_000);
    depsChanged = /(^|\n)(package\.json|package-lock\.json)(\n|$)/.test(changed.stdout || '');
  }
  if (depsChanged || options.install) {
    await run('npm', ['install', '--silent', '--no-audit', '--no-fund'], { timeout: 180_000, cwd: ROOT });
  }

  const summary = (pull.stdout || '').trim().split('\n').filter(Boolean).pop() || 'Updated';

  // The commits that arrived, so the client can show a "What's new" list.
  const commitsOut = await git(['log', '--no-merges', '--pretty=format:%h%x1f%s', `${before}..${after}`], 20_000);
  const commits = (commitsOut.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [hash, subject] = line.split('\x1f');
      return { hash: (hash || '').trim(), subject: (subject || '').trim() };
    })
    .filter((entry) => entry.subject);

  // Restart the login service shortly after this response is delivered so the
  // new code loads. The client polls /api/health and reloads.
  if (options.restart !== false) {
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (uid != null) {
      setTimeout(() => { run('/bin/launchctl', ['kickstart', '-k', `gui/${uid}/local.vantage`]).catch(() => {}); }, 900);
    }
  }

  return { ok: true, before: before.slice(0, 7), after: after.slice(0, 7), depsChanged, commits, summary: summary.slice(0, 200), message: 'Updated. Restarting Vantage…' };
}

module.exports = { status, apply };
