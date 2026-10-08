'use strict';

// Image-model intelligence for ComfyUI: duplicates, likely-unused files and
// type inference.

const os = require('node:os');
const path = require('node:path');

const { listDir, readTextSafe, statSafe } = require('./exec');
const { summarize } = require('./safetensors');

const HOME = os.homedir();
const MODEL_EXT = /\.(safetensors|ckpt|pt|bin|gguf)$/i;

async function workflowReferences() {
  const dirs = [path.join(HOME, '.openclaw', 'workflows'), path.join(HOME, 'ComfyUI', 'user', 'default', 'workflows')];
  const refs = new Set();
  for (const dir of dirs) {
    for (const entry of await listDir(dir)) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const text = await readTextSafe(path.join(dir, entry.name));
      if (!text) continue;
      for (const match of text.matchAll(/[\w.\- ]+\.(safetensors|ckpt|pt|bin|gguf)/gi)) refs.add(match[0].trim());
    }
  }
  return refs;
}

function inferType(name, bytes) {
  const n = String(name).toLowerCase();
  if (n.includes('flux')) return 'FLUX';
  if (n.includes('pony')) return 'SDXL · Pony';
  if (n.includes('xl')) return 'SDXL';
  if (n.includes('sd15') || n.includes('v1-5') || n.includes('sd_v1')) return 'SD 1.5';
  if (n.includes('turbo') || n.includes('lightning')) return 'Turbo';
  if (bytes > 5e9) return 'SDXL-class (~6 GB)';
  if (bytes > 1.2e9) return 'SD1.5-class (~2 GB)';
  return 'unknown';
}

async function analysis(inventory) {
  const comfy = (inventory && inventory.comfyui) || {};
  const refs = await workflowReferences();

  const files = [];
  for (const group of comfy.modelGroups || []) {
    for (const file of group.files || []) {
      files.push({ type: group.type, name: file.name, path: `${group.path}/${file.name}`, bytes: file.bytes || 0, modifiedAt: file.modifiedAt });
    }
  }
  const modelFiles = files.filter((file) => MODEL_EXT.test(file.name));

  const bySize = new Map();
  for (const file of modelFiles) {
    const key = `${file.type}:${file.bytes}`;
    if (!bySize.has(key)) bySize.set(key, []);
    bySize.get(key).push(file);
  }
  const duplicates = [...bySize.values()]
    .filter((group) => group.length > 1 && group[0].bytes > 0)
    .map((group) => ({ type: group[0].type, bytes: group[0].bytes, files: group.map((f) => ({ name: f.name, path: f.path })) }));

  const enriched = modelFiles.map((file) => ({ ...file, modelType: inferType(file.name, file.bytes), referenced: refs.has(file.name) }));
  const unused = enriched.filter((file) => !file.referenced).sort((a, b) => b.bytes - a.bytes);

  return {
    files: enriched.sort((a, b) => b.bytes - a.bytes),
    duplicates,
    unused,
    references: [...refs],
    duplicateBytes: duplicates.reduce((sum, group) => sum + group.bytes * (group.files.length - 1), 0),
    unusedBytes: unused.reduce((sum, file) => sum + file.bytes, 0),
    totalBytes: modelFiles.reduce((sum, file) => sum + file.bytes, 0),
  };
}

async function checkpoint(inventory, input) {
  const resolved = path.resolve(String(input || ''));
  const root = path.join(HOME, 'ComfyUI', 'models');
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    const error = new Error('File is outside the ComfyUI models directory');
    error.status = 403;
    throw error;
  }
  const stat = await statSafe(resolved);
  if (!stat) {
    const error = new Error('File not found');
    error.status = 404;
    throw error;
  }
  let tensors = null;
  if (/\.safetensors$/i.test(resolved)) tensors = await summarize(resolved);
  const report = await analysis(inventory);
  const found = (report.files || []).find((file) => file.path === resolved);
  return {
    path: resolved,
    name: path.basename(resolved),
    bytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    modelType: found ? found.modelType : inferType(path.basename(resolved), stat.size),
    referenced: found ? found.referenced : null,
    safetensors: tensors,
  };
}

module.exports = { analysis, checkpoint };
