'use strict';

// Generates a human-friendly changelog from the git history.
//
// Commits are grouped into releases (by tag, when tags exist; otherwise the
// current version) and then into categories. Conventional-commit prefixes are
// honoured when present, and plain sentences fall back to keyword inference so
// the log reads well even for commits written by hand.

const path = require('node:path');
const { run } = require('./exec');

const ROOT = path.join(__dirname, '..');
const REPO_URL = process.env.VANTAGE_REPO_URL || 'https://github.com/jesse-chelin/vantage';
const GIT = '/usr/bin/git';

const VERSION = (() => {
  try { return require('../package.json').version || '0.0.0'; } catch { return '0.0.0'; }
})();

// Category order for both the Markdown file and the in-app view.
const GROUPS = [
  { key: 'added', label: 'Added', icon: 'sparkle' },
  { key: 'changed', label: 'Changed', icon: 'restart' },
  { key: 'fixed', label: 'Fixed', icon: 'check' },
  { key: 'removed', label: 'Removed', icon: 'trash' },
  { key: 'security', label: 'Security', icon: 'shield' },
  { key: 'performance', label: 'Performance', icon: 'bolt' },
  { key: 'docs', label: 'Documentation', icon: 'file' },
  { key: 'other', label: 'Other', icon: 'box' },
];

const CONVENTIONAL = {
  feat: 'added', feature: 'added', fix: 'fixed', perf: 'performance', docs: 'docs', doc: 'docs',
  refactor: 'changed', style: 'changed', chore: 'other', test: 'other', build: 'other', ci: 'other',
  revert: 'removed', security: 'security', remove: 'removed',
};

// Ordered rules: first match wins. `added` keys intentionally include a few
// app-specific words so hand-written subjects land in a sensible section.
const RULES = [
  ['fixed', /\b(fix|fixes|fixed|repair|repaired|resolve|resolves|resolved|correct|corrects|bugs?\b(?!-)|broken|regression|patch)\b/i],
  ['security', /(\bsecurity\s+(fix|fixes|issue|issues|hole|holes|flaw|flaws|patch|hardening)\b|\bvulnerab|\bcve-?\d|\bxss\b|\bcsrf\b|credential leak|token leak|auth bypass|sandbox escape)/i],
  ['performance', /\b(perf|performance|faster|speed|optimi[sz]e|latency|memo)\b/i],
  ['added', /\b(add|adds|added|introduce|introduces|implement|implemented|support|supports|new|notify|notification|enable|enabled|expose|exposes|console|baseline)\b/i],
  ['changed', /\b(refactor|rework|rename|renamed|rebrand|improve|improved|polish|cleanup|clean up|simplif|simplify|tidy|move|moved|extract|shared)\b/i],
  ['removed', /\b(remove|removes|removed|removing|delete|deleted|drop|dropped|uninstall)\b/i],
  ['docs', /\b(docs?|readme|document|documented|documentation|changelog|comment)\b/i],
];

const NOISE = /^(changelog:|chore\(changelog\)|test:|tmp\b|wip\b)/i;

function git(args, timeout = 20_000) {
  return run(GIT, ['-C', ROOT, ...args], { timeout });
}

function cleanSubject(subject) {
  let text = subject
    .replace(/^([a-zA-Z]+)(?:\(([^)]+)\))?!?:\s+/, (match, type, scope) => (CONVENTIONAL[type.toLowerCase()] ? '' : match))
    .replace(/\s+/g, ' ')
    .replace(/\.$/, '')
    .trim();
  if (!text) text = subject;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function classify(subject) {
  const conventional = subject.match(/^([a-zA-Z]+)(?:\(([^)]+)\))?!?:\s+(.+)$/);
  if (conventional && CONVENTIONAL[conventional[1].toLowerCase()]) {
    return { key: CONVENTIONAL[conventional[1].toLowerCase()], scope: conventional[2] || null, text: cleanSubject(subject) };
  }
  for (const [key, re] of RULES) {
    if (re.test(subject)) return { key, scope: null, text: cleanSubject(subject) };
  }
  return { key: 'other', scope: null, text: cleanSubject(subject) };
}

async function logRange(range) {
  const format = '%h%x1f%s%x1f%b%x1f%ad%x1e';
  const result = await git(['log', '--no-merges', '--date=short', `--pretty=format:${format}`, range]);
  if (!result.ok && !result.stdout) return [];
  return result.stdout
    .split('\x1e')
    .map((chunk) => chunk.replace(/^\n+/, '').trimEnd())
    .filter(Boolean)
    .map((chunk) => {
      const [hash, subject, body, date] = chunk.split('\x1f');
      return { hash: (hash || '').trim(), subject: (subject || '').trim(), body: (body || '').trim(), date: (date || '').trim() };
    })
    .filter((entry) => entry.subject && !NOISE.test(entry.subject));
}

function groupEntries(commits) {
  const byKey = new Map(GROUPS.map((g) => [g.key, []]));
  for (const commit of commits) {
    const { key, scope, text } = classify(commit.subject);
    const bucket = byKey.get(key) || byKey.get('other');
    bucket.push({ text, scope, hash: commit.hash, date: commit.date, subject: commit.subject });
  }
  return GROUPS
    .map((g) => ({ ...g, entries: byKey.get(g.key) }))
    .filter((g) => g.entries.length);
}

async function report() {
  const isRepo = await git(['rev-parse', '--is-inside-work-tree']);
  if (!isRepo.ok || !isRepo.stdout.includes('true')) {
    return { generatedAt: new Date().toISOString(), version: VERSION, repoUrl: REPO_URL, sections: [] };
  }

  const tagsOut = await git(['tag', '--sort=-creatordate']);
  const tags = tagsOut.stdout.trim().split('\n').map((t) => t.trim()).filter(Boolean);

  const ranges = [];
  if (tags.length) {
    ranges.push({ version: 'Unreleased', range: `${tags[0]}..HEAD`, unreleased: true });
    for (let i = 0; i < tags.length; i += 1) {
      const older = tags[i + 1];
      ranges.push({ version: tags[i], range: older ? `${older}..${tags[i]}` : tags[i], unreleased: false });
    }
  } else {
    ranges.push({ version: `v${VERSION}`, range: 'HEAD', unreleased: false });
  }

  const sections = [];
  for (const item of ranges) {
    const commits = await logRange(item.range);
    if (!commits.length) continue;
    sections.push({
      version: item.version,
      unreleased: Boolean(item.unreleased),
      date: commits[0].date,
      groups: groupEntries(commits),
      count: commits.length,
    });
  }

  return { generatedAt: new Date().toISOString(), version: VERSION, repoUrl: REPO_URL, sections };
}

function sectionMarkdown(section, repoUrl) {
  const lines = [];
  const title = section.unreleased ? 'Unreleased' : section.version;
  lines.push(`## ${title}${section.date ? ` (${section.date})` : ''}`);
  lines.push('');
  for (const group of section.groups) {
    lines.push(`### ${group.label}`);
    lines.push('');
    for (const entry of group.entries) {
      const scope = entry.scope ? `**${entry.scope}:** ` : '';
      const link = entry.hash ? ` ([${entry.hash}](${repoUrl}/commit/${entry.hash}))` : '';
      lines.push(`- ${scope}${entry.text}${link}`);
    }
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function toMarkdown(data) {
  const lines = [];
  lines.push('# Changelog');
  lines.push('');
  lines.push('All notable changes to Vantage are documented here.');
  lines.push(`This file is generated from the git history. Refresh it with \`npm run changelog\`.`);
  lines.push('');

  if (!data.sections.length) {
    lines.push('_No changes recorded yet._');
    lines.push('');
    return `${lines.join('\n')}\n`;
  }

  for (const section of data.sections) {
    lines.push(sectionMarkdown(section, data.repoUrl));
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

// Markdown for a single release, used for GitHub Release notes.
function toMarkdownSection(section, repoUrl = REPO_URL) {
  if (!section) return '';
  if (!section.groups || !section.groups.length) return `## ${section.version}\n\n_No notable changes._\n`;
  return sectionMarkdown(section, repoUrl);
}

module.exports = { report, toMarkdown, toMarkdownSection, GROUPS, VERSION, REPO_URL };
