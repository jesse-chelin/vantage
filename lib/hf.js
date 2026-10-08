'use strict';

// Minimal HuggingFace Hub client: model search and file listing.

async function fetchJson(url, timeout = 12_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      const error = new Error(`HuggingFace HTTP ${response.status}`);
      error.status = 502;
      throw error;
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function search(query) {
  const q = String(query || '').trim();
  if (!q) return [];
  const data = await fetchJson(`https://huggingface.co/api/models?search=${encodeURIComponent(q)}&limit=20&sort=downloads&direction=-1`);
  return (Array.isArray(data) ? data : []).map((model) => ({
    id: model.id,
    downloads: model.downloads,
    likes: model.likes,
    pipeline: model.pipeline_tag,
    tags: (model.tags || []).slice(0, 8),
  }));
}

async function files(repo) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    const error = new Error('Invalid repo id');
    error.status = 400;
    throw error;
  }
  const data = await fetchJson(`https://huggingface.co/api/models/${repo}?blobs=true`);
  const list = (data.siblings || [])
    .map((sibling) => ({ name: sibling.rfilename, bytes: sibling.size || null }))
    .filter((entry) => /\.(safetensors|gguf|ckpt|pt|bin)$/i.test(entry.name));
  const tags = data.tags || [];
  const license = (data.cardData && data.cardData.license) || (tags.find((t) => t.startsWith('license:')) || '').slice(8) || null;
  return {
    id: data.id || repo,
    gated: Boolean(data.gated),
    files: list,
    downloads: data.downloads || 0,
    likes: data.likes || 0,
    pipeline: data.pipeline_tag || null,
    lastModified: data.lastModified || null,
    license,
    tags: tags.filter((t) => !t.startsWith('license:')).slice(0, 12),
  };
}

async function trending(limit = 8) {
  const data = await fetchJson(`https://huggingface.co/api/models?sort=trendingScore&direction=-1&limit=${Math.min(20, limit)}`, 10_000);
  return (Array.isArray(data) ? data : []).map((model) => ({
    id: model.id,
    downloads: model.downloads,
    likes: model.likes,
    pipeline: model.pipeline_tag,
    tags: (model.tags || []).slice(0, 5),
  }));
}

module.exports = { search, files, trending };
