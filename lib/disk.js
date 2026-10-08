'use strict';

// Disk exploration and reclaimable-space analysis.
//
// - diskTree(): lazy, depth-1 directory sizes for an interactive treemap.
// - reclaimReport(): finds space that can be safely recovered, orphaned
//   Ollama blobs (present but referenced by no manifest), partial downloads,
//   Trash, caches and stale ComfyUI outputs.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');

const { duChildren, duOne, listDir, statSafe, readJsonSafe, run } = require('./exec');

const HOME = os.homedir();
const ALLOWED_ROOTS = [HOME, '/Applications', '/opt/homebrew'];

function assertPath(input) {
  if (typeof input !== 'string' || !path.isAbsolute(input)) {
    const error = new Error('An absolute path is required');
    error.status = 400;
    throw error;
  }
  const resolved = path.resolve(input);
  if (!ALLOWED_ROOTS.some((root) => resolved === root || resolved.startsWith(root + path.sep))) {
    const error = new Error('Path is outside the allowed locations');
    error.status = 403;
    throw error;
  }
  return resolved;
}

async function diskTree(input) {
  const resolved = assertPath(input);
  const children = await duChildren(resolved, { timeout: 180_000 });
  const totalBytes = children.reduce((sum, child) => sum + (child.bytes || 0), 0);
  return {
    path: resolved,
    totalBytes,
    children: children.map((child) => ({
      name: child.name,
      path: child.path,
      bytes: child.bytes,
      isDirectory: child.isDirectory,
    })),
  };
}

async function forEachManifest(dir, onManifest) {
  for (const entry of await listDir(dir)) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await forEachManifest(full, onManifest);
    else await onManifest(full);
  }
}

async function orphanOllamaBlobs() {
  const manifestsDir = path.join(HOME, '.ollama', 'models', 'manifests');
  const blobsDir = path.join(HOME, '.ollama', 'models', 'blobs');
  const referenced = new Set();

  await forEachManifest(manifestsDir, async (file) => {
    const manifest = await readJsonSafe(file);
    if (!manifest) return;
    if (manifest.config && manifest.config.digest) referenced.add(manifest.config.digest);
    for (const layer of manifest.layers || []) {
      if (layer && layer.digest) referenced.add(layer.digest);
    }
  });

  const blobs = await listDir(blobsDir);
  const orphans = [];
  for (const entry of blobs) {
    if (!entry.isFile()) continue;
    const digest = entry.name.replace(/^sha256-/, 'sha256:');
    if (referenced.has(digest)) continue;
    const stat = await statSafe(path.join(blobsDir, entry.name));
    orphans.push({ name: entry.name, path: path.join(blobsDir, entry.name), bytes: stat ? stat.size : 0 });
  }
  orphans.sort((a, b) => b.bytes - a.bytes);
  return orphans;
}

async function partialDownloads() {
  const roots = [path.join(HOME, 'ComfyUI', 'models'), path.join(HOME, 'Downloads')];
  const partials = [];
  for (const root of roots) {
    let entries = [];
    try {
      entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.aria2')) continue;
      const dir = entry.parentPath || entry.path || root;
      const full = path.join(dir, entry.name);
      const target = full.replace(/\.aria2$/, '');
      const targetStat = await statSafe(target);
      const ariaStat = await statSafe(full);
      partials.push({
        name: path.basename(target),
        path: full,
        targetPath: target,
        bytes: (targetStat ? targetStat.size : 0) + (ariaStat ? ariaStat.size : 0),
      });
    }
  }
  return partials.sort((a, b) => b.bytes - a.bytes);
}

async function oldOutputs(days = 30) {
  const dir = path.join(HOME, 'ComfyUI', 'output');
  let entries = [];
  try {
    entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });
  } catch {
    return { count: 0, bytes: 0, files: [] };
  }
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const files = [];
  let bytes = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const dirPath = entry.parentPath || entry.path || dir;
    const full = path.join(dirPath, entry.name);
    const stat = await statSafe(full);
    if (!stat || stat.mtimeMs >= cutoff) continue;
    bytes += stat.size;
    files.push({ name: entry.name, path: full, bytes: stat.size, modifiedAt: stat.mtime.toISOString() });
  }
  files.sort((a, b) => b.bytes - a.bytes);
  return { count: files.length, bytes, files: files.slice(0, 200) };
}

async function localSnapshots() {
  const result = await run('/usr/bin/tmutil', ['listlocalsnapshots', '/'], { timeout: 15_000 });
  const names = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /\.local$/.test(line));
  return { count: names.length, names: names.slice(0, 8) };
}

async function reclaimReport() {
  const [orphans, partials, trashBytes, old, npmCache, pipCache, brewCache, snapshots] = await Promise.all([
    orphanOllamaBlobs().catch(() => []),
    partialDownloads().catch(() => []),
    duOne(path.join(HOME, '.Trash'), { timeout: 60_000 }).catch(() => null),
    oldOutputs(30).catch(() => ({ count: 0, bytes: 0, files: [] })),
    duOne(path.join(HOME, '.npm'), { timeout: 60_000 }).catch(() => null),
    duOne(path.join(HOME, 'Library', 'Caches', 'pip'), { timeout: 60_000 }).catch(() => null),
    duOne(path.join(HOME, 'Library', 'Caches', 'Homebrew'), { timeout: 60_000 }).catch(() => null),
    localSnapshots().catch(() => ({ count: 0, names: [] })),
  ]);

  const orphanBytes = orphans.reduce((sum, b) => sum + b.bytes, 0);
  const partialBytes = partials.reduce((sum, b) => sum + b.bytes, 0);

  const items = [
    { id: 'ollama-orphans', label: 'Orphaned Ollama blobs', bytes: orphanBytes, count: orphans.length, action: 'ollama.pruneOrphans', detail: 'Blobs referenced by no model manifest' },
    { id: 'trash', label: 'Trash', bytes: trashBytes, count: null, action: 'trash.empty', detail: 'Contents of ~/.Trash' },
    { id: 'npm-cache', label: 'npm cache', bytes: npmCache, count: null, action: 'cache.prune', actionParams: { target: 'npm' }, detail: 'Safe to clear' },
    { id: 'pip-cache', label: 'pip cache', bytes: pipCache, count: null, action: 'cache.prune', actionParams: { target: 'pip' }, detail: 'Safe to clear' },
    { id: 'brew-cache', label: 'Homebrew cache', bytes: brewCache, count: null, action: 'cache.prune', actionParams: { target: 'brew' }, detail: 'Safe to clear' },
    { id: 'old-outputs', label: 'ComfyUI outputs older than 30 days', bytes: old.bytes || 0, count: old.count, action: null, detail: 'Review in Finder' },
  ].filter((item) => (item.bytes || 0) > 0);

  const totalBytes = items.reduce((sum, item) => sum + (item.bytes || 0), 0) + partialBytes;
  return {
    home: HOME,
    totalBytes,
    items,
    orphans: orphans.slice(0, 50),
    partials,
    oldOutputs: { count: old.count, bytes: old.bytes, files: (old.files || []).slice(0, 20) },
    snapshots,
  };
}

async function pruneOllamaOrphans() {
  const orphans = await orphanOllamaBlobs();
  let deleted = 0;
  let bytes = 0;
  for (const blob of orphans) {
    try {
      await fs.unlink(blob.path);
      deleted += 1;
      bytes += blob.bytes;
    } catch {
      /* skip */
    }
  }
  return { message: `Removed ${deleted} orphaned blob${deleted === 1 ? '' : 's'} (${bytes} bytes)`, deleted, bytes };
}

async function emptyTrash() {
  const trash = path.join(HOME, '.Trash');
  let entries = [];
  try {
    entries = await fs.readdir(trash, { withFileTypes: true });
  } catch {
    return { message: 'Trash is already empty', removed: 0 };
  }
  let removed = 0;
  for (const entry of entries) {
    try {
      await fs.rm(path.join(trash, entry.name), { recursive: true, force: true });
      removed += 1;
    } catch {
      /* skip */
    }
  }
  return { message: `Emptied Trash (${removed} item${removed === 1 ? '' : 's'})`, removed };
}

async function largestFiles(input, limit = 50) {
  const root = assertPath(input);
  const out = [];
  let scanned = 0;
  const cap = 250_000;
  const skip = new Set(['.git', 'node_modules', '.Trash', '.cache']);
  async function walk(dir, depth) {
    if (depth > 6 || scanned > cap) return;
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      scanned += 1;
      if (scanned > cap) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue;
        await walk(full, depth + 1);
      } else {
        const stat = await statSafe(full);
        if (stat) out.push({ name: entry.name, path: full, bytes: stat.size });
      }
    }
  }
  await walk(root, 0);
  out.sort((a, b) => b.bytes - a.bytes);
  return { path: root, scanned, files: out.slice(0, limit) };
}

async function moveToTrash(filePath) {
  const trash = path.join(HOME, '.Trash');
  await fs.mkdir(trash, { recursive: true });
  const base = path.basename(filePath);
  let target = path.join(trash, base);
  let n = 1;
  for (;;) {
    try {
      await fs.access(target);
      target = path.join(trash, `${base} ${n}`);
      n += 1;
    } catch {
      break;
    }
  }
  await fs.rename(filePath, target);
  return target;
}

async function discardPartials() {
  const roots = [path.join(HOME, 'ComfyUI', 'models'), path.join(HOME, 'Downloads')];
  let count = 0;
  let bytes = 0;
  for (const root of roots) {
    let entries = [];
    try {
      entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.aria2')) continue;
      const dir = entry.parentPath || entry.path || root;
      const aria = path.join(dir, entry.name);
      const data = aria.replace(/\.aria2$/, '');
      for (const candidate of [aria, data]) {
        const stat = await statSafe(candidate);
        if (!stat) continue;
        try {
          await moveToTrash(candidate);
          count += 1;
          bytes += stat.size;
        } catch {
          /* skip */
        }
      }
    }
  }
  return { message: count ? `Discarded ${count} partial file${count === 1 ? '' : 's'}` : 'No partial downloads', count, bytes };
}

async function trashOldOutputs(days = 30) {
  const { files } = await oldOutputs(days);
  let count = 0;
  let bytes = 0;
  for (const file of files) {
    try {
      await moveToTrash(file.path);
      count += 1;
      bytes += file.bytes || 0;
    } catch {
      /* skip */
    }
  }
  return { message: count ? `Trashed ${count} old output${count === 1 ? '' : 's'}` : 'No old outputs', count, bytes };
}

module.exports = { diskTree, reclaimReport, pruneOllamaOrphans, emptyTrash, orphanOllamaBlobs, largestFiles, discardPartials, trashOldOutputs, moveToTrash };
