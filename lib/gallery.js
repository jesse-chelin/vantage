'use strict';

// ComfyUI output gallery: lists generated images and extracts the embedded
// prompt/workflow metadata for each.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');

const { statSafe, fetchJson } = require('./exec');

const HOME = os.homedir();
const OUTPUT_DIR = path.join(HOME, 'ComfyUI', 'output');
const COMFY_HOST = 'http://127.0.0.1:8188';

function parsePngText(buffer) {
  if (buffer.length < 8 || buffer.readUInt32BE(0) !== 0x89504e47) return null;
  const meta = {};
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) break;
    if (type === 'tEXt') {
      const data = buffer.subarray(dataStart, dataEnd);
      const zero = data.indexOf(0);
      if (zero > 0) meta[data.toString('latin1', 0, zero)] = data.toString('latin1', zero + 1);
    } else if (type === 'iTXt') {
      const data = buffer.subarray(dataStart, dataEnd);
      const zero = data.indexOf(0);
      if (zero > 0) {
        let idx = zero + 3; // skip compression flag + method + null
        const langEnd = data.indexOf(0, idx);
        idx = (langEnd > 0 ? langEnd : idx) + 1;
        const transEnd = data.indexOf(0, idx);
        idx = (transEnd > 0 ? transEnd : idx) + 1;
        meta[data.toString('latin1', 0, zero)] = data.toString('utf8', idx);
      }
    } else if (type === 'IDAT' || type === 'IEND') {
      break;
    }
    offset = dataEnd + 4;
  }
  return meta;
}

function summarizePrompt(prompt) {
  const out = {};
  if (!prompt || typeof prompt !== 'object') return out;
  const textOf = (ref) => {
    if (!Array.isArray(ref)) return null;
    const node = prompt[ref[0]];
    const inputs = node && node.inputs;
    return inputs && typeof inputs.text === 'string' ? inputs.text : null;
  };
  for (const node of Object.values(prompt)) {
    const type = node && node.class_type;
    const inputs = (node && node.inputs) || {};
    if (type === 'KSampler' || type === 'KSamplerAdvanced') {
      out.seed = inputs.seed;
      out.steps = inputs.steps;
      out.cfg = inputs.cfg;
      out.sampler = inputs.sampler_name;
      out.scheduler = inputs.scheduler;
      out.denoise = inputs.denoise;
      const pos = textOf(inputs.positive);
      const neg = textOf(inputs.negative);
      if (pos) out.positive = pos;
      if (neg) out.negative = neg;
    }
    if (type === 'CheckpointLoaderSimple' || type === 'CheckpointLoader') out.model = inputs.ckpt_name;
    if (type === 'EmptyLatentImage') {
      out.width = inputs.width;
      out.height = inputs.height;
    }
    if (type === 'LoraLoader') out.lora = inputs.lora_name;
  }
  return out;
}

async function listImages(limit = 48) {
  let entries = [];
  try {
    entries = await fs.readdir(OUTPUT_DIR, { recursive: true, withFileTypes: true });
  } catch {
    return [];
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/\.(png|webp|jpe?g)$/i.test(entry.name)) continue;
    const dir = entry.parentPath || entry.path || OUTPUT_DIR;
    const full = path.join(dir, entry.name);
    const stat = await statSafe(full);
    if (stat) candidates.push({ path: full, bytes: stat.size, mtime: stat.mtimeMs, modifiedAt: stat.mtime.toISOString() });
  }
  candidates.sort((a, b) => b.mtime - a.mtime);

  const images = [];
  for (const item of candidates.slice(0, limit)) {
    let meta = {};
    if (/\.png$/i.test(item.path)) {
      try {
        const handle = await fs.open(item.path, 'r');
        const buffer = Buffer.alloc(256 * 1024);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        await handle.close();
        const chunks = parsePngText(buffer.subarray(0, bytesRead));
        if (chunks && chunks.prompt) meta = summarizePrompt(JSON.parse(chunks.prompt));
      } catch {
        meta = {};
      }
    }
    images.push({ name: path.basename(item.path), path: item.path, bytes: item.bytes, modifiedAt: item.modifiedAt, meta });
  }
  return images;
}

function assertOutputPath(target) {
  const resolved = path.resolve(target);
  if (!resolved.startsWith(OUTPUT_DIR + path.sep)) {
    const error = new Error('Image is outside the ComfyUI output directory');
    error.status = 403;
    throw error;
  }
  return resolved;
}

async function queue() {
  const data = await fetchJson(`${COMFY_HOST}/queue`, 4000);
  if (!data) return { available: false, running: 0, pending: 0, runningItems: [], pendingItems: [] };
  const running = data.queue_running || [];
  const pending = data.queue_pending || [];
  return {
    available: true,
    running: running.length,
    pending: pending.length,
    runningItems: running.slice(0, 5).map((entry) => ({ id: entry[1] || entry[0] })),
    pendingItems: pending.slice(0, 10).map((entry) => ({ id: entry[1] || entry[0] })),
  };
}

async function interrupt() {
  const response = await fetch(`${COMFY_HOST}/interrupt`, { method: 'POST' }).catch(() => null);
  if (!response) return { message: 'ComfyUI is not reachable' };
  return { message: response.ok ? 'Interrupt requested' : `ComfyUI returned ${response.status}` };
}

async function clearQueue() {
  const response = await fetch(`${COMFY_HOST}/queue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clear: true }),
  }).catch(() => null);
  if (!response) return { message: 'ComfyUI is not reachable' };
  return { message: response.ok ? 'Pending queue cleared' : `ComfyUI returned ${response.status}` };
}

async function history(limit = 20) {
  const data = await fetchJson(`${COMFY_HOST}/history?max_items=${limit}`, 5000);
  if (!data) return [];
  return Object.entries(data)
    .map(([id, entry]) => ({ id, status: entry.status && entry.status.completed ? 'completed' : 'unknown', created: entry.prompt && entry.prompt[2] ? entry.prompt[2].create_time : null }))
    .sort((a, b) => (b.created || 0) - (a.created || 0))
    .slice(0, limit);
}

module.exports = { listImages, assertOutputPath, queue, interrupt, clearQueue, history, OUTPUT_DIR };
