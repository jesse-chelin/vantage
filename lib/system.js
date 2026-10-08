'use strict';

// Reads a couple of macOS system preferences the UI likes to mirror.

const { run } = require('./exec');

// AppleAccentColor: -1 graphite, 0 red, 1 orange, 2 yellow, 3 green, 4 blue,
// 5 purple, 6 pink; unset = multicolour (treat as blue).
const ACCENTS = { '-1': 'graphite', 0: 'red', 1: 'orange', 2: 'yellow', 3: 'green', 4: 'blue', 5: 'purple', 6: 'pink' };

async function accent() {
  const result = await run('/usr/bin/defaults', ['read', '-g', 'AppleAccentColor'], { timeout: 5000 });
  if (!result.ok) return 'blue';
  const value = result.stdout.trim();
  return ACCENTS[value] || 'blue';
}

async function info() {
  return { accent: await accent() };
}

module.exports = { info };
