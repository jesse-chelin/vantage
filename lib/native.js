'use strict';

// Build + launch the native WKWebView app shell.

const path = require('node:path');
const fssync = require('node:fs');

const { run } = require('./exec');

const DIR = path.join(__dirname, '..', 'native');
const APP = path.join(DIR, 'Vantage.app');
const SCRIPT = path.join(DIR, 'build.sh');

function exists() {
  return fssync.existsSync(path.join(APP, 'Contents', 'MacOS', 'Vantage'));
}

async function build() {
  const result = await run('/bin/sh', [SCRIPT], { timeout: 180_000 });
  if (!result.ok || !exists()) {
    const error = new Error((result.stderr || result.stdout || 'Build failed').trim().slice(0, 240));
    error.status = 500;
    throw error;
  }
  return { message: 'Native app built' };
}

async function launch() {
  if (!exists()) await build();
  const result = await run('/usr/bin/open', [APP], { timeout: 15_000 });
  if (!result.ok) {
    const error = new Error((result.stderr || 'Could not open the app').trim().slice(0, 160));
    error.status = 500;
    throw error;
  }
  return { message: 'Vantage app opened' };
}

module.exports = { build, launch, exists, APP };
