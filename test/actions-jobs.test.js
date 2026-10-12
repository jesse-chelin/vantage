'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

const { createJob, getJob, brewPhase } = require('../lib/actions');

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

test('brewPhase turns Homebrew markers into step labels', () => {
  assert.equal(brewPhase('==> Fetching dependencies for wget'), 'Fetching dependencies for wget');
  assert.equal(brewPhase('==> Pouring wget--1.0.arm64_sonoma.bottle.tar.gz'), 'Pouring wget--1.0.arm64_sonoma.bottle.tar.gz');
  assert.equal(brewPhase('plain output line'), null);
  assert.equal(brewPhase(''), null);
});

test('job steps follow phases and finish when the process closes', () => {
  const child = fakeChild();
  const job = createJob('brew.install', { name: 'wget' }, child, { stepFromLine: brewPhase });

  child.stdout.emit('data', '==> Downloading wget\n==> Pouring wget\n');
  let view = getJob(job.id);
  assert.equal(view.steps.length, 2);
  assert.equal(view.steps[0].label, 'Downloading wget');
  assert.equal(view.steps[0].status, 'done', 'the earlier phase closes when the next starts');
  assert.equal(view.steps[1].label, 'Pouring wget');
  assert.equal(view.steps[1].status, 'active');

  child.emit('close', 0);
  view = getJob(job.id);
  assert.equal(view.status, 'done');
  assert.equal(view.steps[1].status, 'done', 'the active step finishes with the job');
});

test('a failing job marks the active step as failed', () => {
  const child = fakeChild();
  const job = createJob('brew.install', { name: 'nope' }, child, { stepFromLine: brewPhase });
  child.stdout.emit('data', '==> Installing nope\n');
  child.emit('close', 1);
  const view = getJob(job.id);
  assert.equal(view.status, 'failed');
  assert.equal(view.steps[0].status, 'failed');
});
