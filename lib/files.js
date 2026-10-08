'use strict';

// Basic file detail (type, size, permissions, modified).

const os = require('node:os');
const path = require('node:path');

const { run, statSafe } = require('./exec');

const HOME = os.homedir();

async function detail(input) {
  const resolved = path.resolve(String(input || ''));
  if (!resolved.startsWith(HOME + path.sep)) {
    const error = new Error('Path is outside the home directory');
    error.status = 403;
    throw error;
  }
  const stat = await statSafe(resolved);
  if (!stat) {
    const error = new Error('File not found');
    error.status = 404;
    throw error;
  }
  const type = await run('/usr/bin/file', ['-b', resolved], { timeout: 6000 });
  return {
    path: resolved,
    name: path.basename(resolved),
    bytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    created: stat.birthtime ? stat.birthtime.toISOString() : null,
    mode: (stat.mode & 0o777).toString(8),
    type: type.stdout.trim() || null,
    isDirectory: stat.isDirectory(),
  };
}

module.exports = { detail };
