'use strict';

// In-app update checking and updating, backed by the local git checkout.
// Everything is best-effort: a missing checkout or a failed fetch resolves to a
// status object rather than throwing.

const fs = require('node:fs');
const path = require('node:path');
const { run } = require('./exec');

const ROOT = path.join(__dirname, '..');

function git(args, timeout = 20_000) {
  return run('/usr/bin/git', ['-C', ROOT, ...args], { timeout });
}

async function status() {
  if (!fs.existsSync(path.join(ROOT, '.git'))) {
    return { supported: false, available: false, reason: 'Not a git checkout' };
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
    return { supported: true, available: false, current: current.slice(0, 7), reason: 'No upstream branch', fetched: fetch.ok };
  }

  const upstream = (await git(['rev-parse', '--verify', '--quiet', upstreamRef])).stdout.trim();
  if (!upstream) {
    return { supported: true, available: false, current: current.slice(0, 7), upstream: upstreamRef, reason: 'Upstream not fetched', fetched: fetch.ok };
  }

  const behind = Number((await git(['rev-list', '--count', `${current}..${upstream}`])).stdout.trim()) || 0;
  const ahead = Number((await git(['rev-list', '--count', `${upstream}..${current}`])).stdout.trim()) || 0;
  const subject = (await git(['log', '-1', '--format=%s', upstream])).stdout.trim();
  const date = (await git(['log', '-1', '--format=%cI', upstream])).stdout.trim();

  return {
    supported: true,
    available: behind > 0,
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

async function apply() {
  if (!fs.existsSync(path.join(ROOT, '.git'))) {
    throw Object.assign(new Error('This install is not a git checkout, so it cannot self-update.'), { status: 400 });
  }

  const pull = await git(['pull', '--ff-only'], 120_000);
  if (!pull.ok) {
    const message = (pull.stderr || pull.stdout || pull.error || 'git pull failed').trim().slice(0, 300);
    throw Object.assign(new Error(message), { status: 500 });
  }

  const summary = (pull.stdout || '').trim().split('\n').filter(Boolean).pop() || 'Updated';

  // Restart the login service shortly after this response is delivered so the
  // new code loads. The client polls /api/health and reloads.
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (uid != null) {
    setTimeout(() => { run('/bin/launchctl', ['kickstart', '-k', `gui/${uid}/local.vantage`]).catch(() => {}); }, 900);
  }

  return { ok: true, summary: summary.slice(0, 200), message: 'Updated. Restarting Vantage…' };
}

module.exports = { status, apply };
