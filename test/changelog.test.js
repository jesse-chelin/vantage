'use strict';

const test = require('node:test');
const assert = require('node:assert');

const changelog = require('../lib/changelog');

test('changelog.report groups the git history into release sections', async () => {
  const data = await changelog.report();
  assert.equal(typeof data.version, 'string');
  assert.ok(Array.isArray(data.sections));
  assert.ok(data.sections.length >= 1, 'expected at least one section');
  for (const section of data.sections) {
    assert.equal(typeof section.version, 'string');
    assert.ok(Array.isArray(section.groups));
    for (const group of section.groups) {
      assert.ok(Array.isArray(group.entries));
      assert.ok(group.entries.length >= 1);
    }
  }
});

test('changelog.toMarkdown renders versions, groups and commit links', () => {
  const markdown = changelog.toMarkdown({
    repoUrl: 'https://example.com/repo',
    sections: [{
      version: 'v1.0.0',
      unreleased: false,
      date: '2026-01-01',
      groups: [{ key: 'added', label: 'Added', icon: 'sparkle', entries: [{ text: 'Did a thing', scope: 'core', hash: 'abc1234' }] }],
    }],
  });
  assert.match(markdown, /^# Changelog/);
  assert.match(markdown, /## v1\.0\.0 \(2026-01-01\)/);
  assert.match(markdown, /### Added/);
  assert.match(markdown, /\*\*core:\*\* Did a thing/);
  assert.match(markdown, /https:\/\/example\.com\/repo\/commit\/abc1234/);
});

test('changelog.toMarkdown handles an empty history', () => {
  const markdown = changelog.toMarkdown({ repoUrl: 'https://example.com', sections: [] });
  assert.match(markdown, /_No changes recorded yet\._/);
});
