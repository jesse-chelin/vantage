'use strict';

// Homebrew catalogue: search, info, installed state, and a curated app list.

const { run } = require('./exec');

const BREW = '/opt/homebrew/bin/brew';
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9@+._/-]{0,120}$/;

let cache = { formulae: null, casks: null, ts: 0 };

function clearCache() {
  cache = { formulae: null, casks: null, ts: 0 };
}

async function installed(force = false) {
  if (!force && cache.formulae && Date.now() - cache.ts < 8000) return cache;
  const [formulae, casks] = await Promise.all([
    run(BREW, ['list', '--formula'], { timeout: 60_000 }),
    run(BREW, ['list', '--cask'], { timeout: 60_000 }),
  ]);
  cache = {
    formulae: new Set(formulae.stdout.split('\n').map((l) => l.trim()).filter(Boolean)),
    casks: new Set(casks.stdout.split('\n').map((l) => l.trim()).filter(Boolean)),
    ts: Date.now(),
  };
  return cache;
}

async function search(query, kind = 'formula') {
  const q = String(query || '').trim();
  if (!q) return [];
  const args = kind === 'cask' ? ['search', '--cask', q] : ['search', '--formula', q];
  const result = await run(BREW, args, { timeout: 60_000 });
  const names = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('==>') && !line.includes(' '));
  const state = await installed();
  const set = kind === 'cask' ? state.casks : state.formulae;
  return names.slice(0, 40).map((name) => ({ name, kind, installed: set.has(name) }));
}

const FEATURED_CASKS = [
  ['lm-studio', 'Run local LLMs with a desktop GUI'],
  ['jan', 'Open-source offline ChatGPT alternative'],
  ['msty', 'Multi-model desktop chat client'],
  ['anythingllm', 'All-in-one local RAG desktop app'],
  ['cherry-studio', 'Multi-LLM desktop client'],
  ['chatgpt', 'OpenAI ChatGPT desktop app'],
  ['claude', 'Anthropic Claude desktop app'],
  ['cursor', 'AI-first code editor'],
  ['visual-studio-code', 'Code editor with AI extensions'],
  ['zed', 'High-performance multiplayer editor'],
  ['warp', 'Agentic terminal'],
  ['ghostty', 'Fast GPU-accelerated terminal'],
  ['raycast', 'Launcher with AI commands'],
  ['orbstack', 'Fast Docker & Linux machines'],
  ['docker', 'Container platform'],
  ['tailscale', 'Zero-config mesh VPN'],
  ['obsidian', 'Markdown knowledge base'],
  ['daisydisk', 'Disk usage visualiser'],
  ['stats', 'Menu bar system monitor'],
  ['iina', 'Modern video player'],
  ['handbrake', 'Video transcoder'],
  ['blender', '3D creation suite'],
  ['appcleaner', 'Uninstall apps cleanly'],
  ['rectangle', 'Window management'],
];

async function featured() {
  const state = await installed();
  return FEATURED_CASKS.map(([name, desc]) => ({ name, kind: 'cask', desc, installed: state.casks.has(name) }));
}

async function info(name, kind = 'formula') {
  const safe = String(name || '');
  if (!NAME_RE.test(safe)) {
    const error = new Error('Invalid package name');
    error.status = 400;
    throw error;
  }
  const state = await installed();
  const set = kind === 'cask' ? state.casks : state.formulae;
  const args = kind === 'cask' ? ['info', '--json=v2', '--cask', safe] : ['info', '--json=v2', safe];
  const result = await run(BREW, args, { timeout: 60_000 });
  let item = null;
  try {
    const data = JSON.parse(result.stdout);
    item = kind === 'cask' ? data.casks && data.casks[0] : data.formulae && data.formulae[0];
  } catch {
    item = null;
  }
  if (!item) return { name: safe, kind, installed: set.has(safe) };
  const token = item.token || item.name || safe;
  return {
    name: token,
    kind,
    desc: item.desc || null,
    homepage: item.homepage || null,
    version: item.versions ? item.versions.stable || item.version : item.version,
    installed: set.has(token),
    deps: (item.dependencies || []).slice(0, 24),
    caveats: item.caveats || null,
  };
}

module.exports = { search, info, featured, installed, NAME_RE, clearCache };
