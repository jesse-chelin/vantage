'use strict';

// In-memory diagnostics ring buffer: captures console.error/warn and unhandled
// rejections/exceptions so they can be surfaced in the dashboard.

const MAX = 200;
const ring = [];

function record(level, message) {
  ring.push({ ts: Date.now(), level, message: String(message == null ? '' : message).slice(0, 800) });
  if (ring.length > MAX) ring.splice(0, ring.length - MAX);
}

function list() {
  return [...ring].reverse();
}

function install() {
  if (install.done) return;
  install.done = true;
  const originalError = console.error.bind(console);
  console.error = (...args) => {
    record('error', args.map((a) => (a && a.stack) || a).join(' '));
    originalError(...args);
  };
  const originalWarn = console.warn.bind(console);
  console.warn = (...args) => {
    record('warn', args.map((a) => (a && a.stack) || a).join(' '));
    originalWarn(...args);
  };
  process.on('unhandledRejection', (reason) => record('error', `unhandledRejection: ${(reason && reason.stack) || reason}`));
  process.on('uncaughtException', (error) => record('error', `uncaughtException: ${(error && error.stack) || error}`));
}

module.exports = { record, list, install };
