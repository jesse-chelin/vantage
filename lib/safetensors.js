'use strict';

// Minimal safetensors header reader: tensor count, parameter count, dtypes
// and embedded metadata, without loading the (multi-GB) weights.

const fs = require('node:fs/promises');

async function header(file) {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const lengthBuffer = Buffer.alloc(8);
    await handle.read(lengthBuffer, 0, 8, 0);
    const headerLength = Number(lengthBuffer.readBigUInt64LE(0));
    if (!headerLength || headerLength > 200 * 1024 * 1024) return null;
    const buffer = Buffer.alloc(headerLength);
    await handle.read(buffer, 0, headerLength, 8);
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    return null;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function summarize(file) {
  const json = await header(file);
  if (!json) return null;
  let tensors = 0;
  let params = 0;
  let bytes = 0;
  const dtypes = {};
  const prefixes = new Set();
  for (const [key, value] of Object.entries(json)) {
    if (key === '__metadata__' || !value || !Array.isArray(value.shape)) continue;
    tensors += 1;
    params += value.shape.reduce((product, dim) => product * dim, 1);
    if (Array.isArray(value.data_offsets)) bytes += value.data_offsets[1] - value.data_offsets[0];
    if (value.dtype) dtypes[value.dtype] = (dtypes[value.dtype] || 0) + 1;
    prefixes.add(key.split('.')[0]);
  }
  return {
    tensors,
    params,
    bytes,
    dtypes,
    metadata: json.__metadata__ || null,
    keyPrefixes: [...prefixes].slice(0, 12),
    sdxl: Object.keys(json).some((key) => key.startsWith('conditioner.embedders')) || Object.keys(json).some((key) => key.startsWith('model.diffusion_model')),
  };
}

module.exports = { header, summarize };
