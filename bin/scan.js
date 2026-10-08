'use strict';

// One-shot inventory scan from the command line. Useful for testing and for
// piping the JSON somewhere else.
//
//   node bin/scan.js            # print a summary
//   node bin/scan.js --json     # print full JSON
//   node bin/scan.js --out f.json

const fs = require('node:fs/promises');
const path = require('node:path');
const { scanAll } = require('../lib/scanner');

function fmtBytes(bytes) {
  if (bytes == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(Math.max(1, bytes)) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(1)} ${units[i]}`;
}

(async () => {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const outIndex = args.indexOf('--out');
  const outFile = outIndex !== -1 ? args[outIndex + 1] : null;

  const startedAt = Date.now();
  const data = await scanAll((label) => {
    if (!asJson) process.stderr.write(`\r\x1b[2K• ${label}…`);
  });
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  if (!asJson) process.stderr.write(`\r\x1b[2K✓ scanned in ${elapsed}s\n`);

  if (outFile) {
    await fs.writeFile(path.resolve(outFile), JSON.stringify(data, null, 2));
    if (!asJson) console.log(`Wrote ${path.resolve(outFile)}`);
  }

  if (asJson) {
    process.stdout.write(JSON.stringify(data, null, 2));
    return;
  }

  const s = data.summary || {};
  console.log('');
  console.log(`Machine:        ${data.system?.model} · ${data.system?.chip} · ${data.system?.physicalMemoryLabel}`);
  console.log(`Disk free:      ${fmtBytes(data.system?.disk?.freeBytes)} of ${fmtBytes(data.system?.disk?.totalBytes)}`);
  console.log(`AI footprint:   ${fmtBytes(s.aiFootprintBytes)}`);
  console.log(`Ollama:         ${s.counts?.ollamaModels} models, ${fmtBytes(data.ollama?.totalBytes)}`);
  console.log(`Image models:   ${s.counts?.comfyCheckpoints} checkpoints, ${fmtBytes(data.comfyui?.modelsTotalBytes)}`);
  console.log(`Homebrew:       ${s.counts?.brewPackages} formulae`);
  console.log(`Apps:           ${s.counts?.apps}`);
  console.log(`Services up:    ${s.counts?.services}`);
  for (const category of s.categories || []) {
    console.log(`  - ${category.name.padEnd(22)} ${fmtBytes(category.bytes)}`);
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
