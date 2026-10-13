'use strict';

// The current user's account picture. macOS keeps it in the local directory
// service as a hex-encoded JPEG (`dscl . -read /Users/<user> JPEGPhoto`); it is
// the same image shown on the login screen and in System Settings. We decode it
// once and serve it to the browser so Vantage can show the real avatar instead
// of an initial. Best-effort: if there is no picture, callers get null and the
// UI keeps its letter avatar.

const os = require('node:os');
const { run } = require('./exec');

const DSCL = '/usr/bin/dscl';
const CACHE_MS = 5 * 60 * 1000;

let cache = { at: 0, value: null };

function username() {
  try {
    return os.userInfo().username || process.env.USER || '';
  } catch {
    return process.env.USER || '';
  }
}

// dscl prints `JPEGPhoto:` on its own line, then the data as space-separated
// hex. Drop everything up to the colon, then require the rest to be pure hex.
function decode(stdout) {
  const raw = String(stdout || '');
  const colon = raw.indexOf(':');
  if (colon === -1) return null;
  const hex = raw.slice(colon + 1).replace(/\s+/g, '');
  if (!hex || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return null;
  const buf = Buffer.from(hex, 'hex');
  // JPEG magic, so a gif/png/empty record never reaches the browser.
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return null;
  return buf;
}

async function read() {
  const now = Date.now();
  if (cache.value && now - cache.at < CACHE_MS) return cache.value;
  const user = username();
  if (!user) return null;
  const result = await run(DSCL, ['.', '-read', `/Users/${user}`, 'JPEGPhoto'], { timeout: 5000 });
  const value = result.ok ? decode(result.stdout) : null;
  cache = { at: now, value };
  return value;
}

function reset() {
  cache = { at: 0, value: null };
}

module.exports = { read, reset, username };
