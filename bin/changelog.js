#!/usr/bin/env node
'use strict';

// Writes CHANGELOG.md from the git history.
//
//   node bin/changelog.js            write CHANGELOG.md
//   node bin/changelog.js --stdout   print it instead
//   node bin/changelog.js --json     print the structured data

const fs = require('node:fs');
const path = require('node:path');
const changelog = require('../lib/changelog');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);

(async () => {
  const data = await changelog.report();

  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    return;
  }

  const markdown = changelog.toMarkdown(data);

  if (args.includes('--stdout') || args.includes('-')) {
    process.stdout.write(markdown);
    return;
  }

  const target = path.join(ROOT, 'CHANGELOG.md');
  fs.writeFileSync(target, markdown);
  const entries = data.sections.reduce((total, section) => total + section.count, 0);
  const sections = data.sections.length;
  console.log(`Wrote ${path.relative(process.cwd(), target)} (${entries} entr${entries === 1 ? 'y' : 'ies'} across ${sections} release${sections === 1 ? '' : 's'}).`);
})().catch((error) => {
  console.error(`Changelog generation failed: ${error.message}`);
  process.exit(1);
});
