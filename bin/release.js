#!/usr/bin/env node
'use strict';

// Cut a release: bump the version, tag it and refresh the changelog.
//
// The changelog (and the GitHub release workflow) define a "version" by its git
// tag, so anything committed after the newest tag shows up as "Unreleased".
// Running a release turns those commits into a real version section.
//
//   node bin/release.js patch            # 0.9.0-beta -> 0.9.1-beta
//   node bin/release.js minor            # 0.9.0-beta -> 0.10.0-beta
//   node bin/release.js major            # 0.9.0-beta -> 1.0.0-beta
//   node bin/release.js stable           # 0.9.0-beta -> 0.9.0
//   node bin/release.js 0.10.0-rc.1      # explicit version
//   node bin/release.js minor --push     # also push the branch and the tag
//
// Flags: --push, --stable, --pre <tag>, --dry-run, --no-test, --force

const fs = require('node:fs');
const path = require('node:path');
const { run } = require('../lib/exec');

const ROOT = path.join(__dirname, '..');
const PKG_FILE = path.join(ROOT, 'package.json');
const CHANGELOG_FILE = path.join(ROOT, 'CHANGELOG.md');
const GIT = '/usr/bin/git';

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.]+))?$/;

function parseVersion(value) {
  const match = SEMVER.exec(String(value || '').trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre: match[4] || null };
}

function formatVersion({ major, minor, patch, pre }) {
  return `${major}.${minor}.${patch}${pre ? `-${pre}` : ''}`;
}

// patch/minor/major increment the numbers and keep a prerelease suffix (so a
// beta line stays beta); `stable` keeps the numbers and drops the suffix. An
// explicit x.y.z(-pre) is used as-is.
function nextVersion(current, requested, options = {}) {
  if (SEMVER.test(String(requested || '').trim())) return String(requested).trim();
  const parsed = parseVersion(current);
  if (!parsed) throw new Error(`Current version "${current}" is not semver (expected x.y.z or x.y.z-pre).`);
  let { major, minor, patch } = parsed;
  const key = String(requested || '').toLowerCase();
  if (key === 'major') { major += 1; minor = 0; patch = 0; }
  else if (key === 'minor') { minor += 1; patch = 0; }
  else if (key === 'patch') { patch += 1; }
  else if (key !== 'stable' && key !== 'release') throw new Error(`Unknown bump "${requested}". Use patch, minor, major, stable or an explicit version.`);
  let pre = parsed.pre;
  if (options.stable || key === 'stable' || key === 'release') pre = null;
  if (options.pre != null) pre = String(options.pre).replace(/^-/, '') || null;
  return formatVersion({ major, minor, patch, pre });
}

async function git(gitArgs, timeout = 30_000) {
  const result = await run(GIT, ['-C', ROOT, ...gitArgs], { timeout });
  if (!result.ok) throw new Error(`git ${gitArgs.slice(0, 2).join(' ')} failed: ${(result.stderr || result.error || '').trim()}`);
  return result.stdout.trim();
}

function usage() {
  console.log('Usage: node bin/release.js <patch|minor|major|stable|<version>> [--push] [--stable] [--pre <tag>] [--dry-run] [--no-test] [--force]');
}

async function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const positional = args.filter((a) => !a.startsWith('--'));
  const preIndex = args.indexOf('--pre');
  const options = {
    stable: flags.has('--stable'),
    pre: preIndex !== -1 ? args[preIndex + 1] : null,
  };
  const dryRun = flags.has('--dry-run');
  const push = flags.has('--push');
  const force = flags.has('--force');
  const runTests = !flags.has('--no-test');

  if (flags.has('--help') || flags.has('-h')) return usage();

  const requested = positional[0] || (flags.has('--major') ? 'major' : flags.has('--patch') ? 'patch' : 'minor');
  const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
  const current = pkg.version;
  const next = nextVersion(current, requested, options);
  const tag = `v${next}`;

  const status = await git(['status', '--porcelain']);
  if (status && !force && !dryRun) throw new Error('Working tree is not clean. Commit or stash first (or pass --force).');
  if (await git(['tag', '--list', tag])) throw new Error(`Tag ${tag} already exists.`);

  console.log(`Release ${current} -> ${next} (tag ${tag})`);
  if (dryRun) {
    console.log('Dry run: nothing written.');
    return;
  }

  if (runTests) {
    console.log('Running tests…');
    const tests = await run(process.execPath, ['--test'], { cwd: ROOT, timeout: 300_000 });
    if (!tests.ok) {
      process.stderr.write(tests.stdout || '');
      process.stderr.write(tests.stderr || '');
      throw new Error('Tests failed, aborting release.');
    }
  }

  pkg.version = next;
  fs.writeFileSync(PKG_FILE, `${JSON.stringify(pkg, null, 2)}\n`);
  await git(['add', 'package.json']);
  await git(['commit', '-m', `release: ${tag}`]);
  await git(['tag', '-a', tag, '-m', tag]);
  console.log(`Committed and tagged ${tag}.`);

  // Regenerate now that the tag exists, so these commits become the new version
  // section instead of "Unreleased". This refresh commit is filtered as noise.
  const changelog = require('../lib/changelog');
  const data = await changelog.report();
  const latest = data.sections.find((section) => section.version === tag || section.version === next);
  if (!latest) console.warn(`Warning: no changelog entries found for ${tag} (nothing since the last release?).`);
  fs.writeFileSync(CHANGELOG_FILE, changelog.toMarkdown(data));
  await git(['add', 'CHANGELOG.md']);
  await git(['commit', '-m', 'changelog: refresh']);
  console.log('Refreshed CHANGELOG.md.');

  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (push) {
    await git(['push', 'origin', branch], 120_000);
    await git(['push', 'origin', tag], 120_000);
    console.log(`Pushed ${branch} and ${tag}. The GitHub release will publish from the tag.`);
  } else {
    console.log(`\nNext:\n  git push origin ${branch}\n  git push origin ${tag}\n(Pushing the tag publishes the GitHub release.)`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Release failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { parseVersion, formatVersion, nextVersion, SEMVER };
