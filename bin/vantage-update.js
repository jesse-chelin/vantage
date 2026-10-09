#!/usr/bin/env node
'use strict';

// Shared updater used by both update.sh and (indirectly) the in-app updater.
// Keeping one implementation means the terminal and the toolbar behave alike.
//
//   node bin/vantage-update.js           pull, restart, rebuild native if it changed
//   node bin/vantage-update.js --check   report status, exit 10 if an update waits
//   node bin/vantage-update.js --native  force a native app rebuild
//   node bin/vantage-update.js --json    machine-readable result

const update = require('../lib/update');

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);

(async () => {
  const status = await update.status();

  if (has('--check')) {
    if (has('--json')) {
      process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    } else if (!status.supported) {
      console.log('This install is not a git checkout, so it cannot self-update.');
    } else if (status.available) {
      console.log(`${status.behind} update${status.behind === 1 ? '' : 's'} available (${status.current} → ${status.latest}): ${status.subject}`);
    } else {
      console.log(`Vantage is up to date (${status.current}).`);
    }
    process.exit(status.available ? 10 : 0);
  }

  if (!status.supported) {
    console.error('This install is not a git checkout. Update by re-running install.sh or re-cloning.');
    process.exit(1);
  }
  if (!status.available) {
    console.log(`Vantage is already up to date (${status.current}).`);
    return;
  }

  console.log(`Updating ${status.behind} commit${status.behind === 1 ? '' : 's'}: ${status.subject}`);
  const result = await update.apply(has('--native') ? { native: true } : {});
  console.log(`Updated ${result.before} → ${result.after}.`);
  if (result.depsChanged) console.log('Refreshed dependencies.');
  if (result.nativeBuilt) console.log('Rebuilt the native Mac app.');
  else if (result.nativeChanged && result.nativeReason) console.log(`Native rebuild skipped: ${result.nativeReason}`);
  console.log(result.message);
})().catch((error) => {
  console.error(`Update failed: ${error.message}`);
  process.exit(1);
});
