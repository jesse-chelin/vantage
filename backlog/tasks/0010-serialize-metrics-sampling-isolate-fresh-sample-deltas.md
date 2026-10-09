# 0010 — Serialize metrics sampling / isolate fresh-sample deltas

- severity: medium
- area: bug
- status: ready
- depends_on: none
- files: lib/metrics.js, server.js
- source: audit B4

## Summary
lastCpu/lastNet are mutated by both the 15s sampler and ?fresh=1, producing cpu:null and distorted net rates when they overlap.

## Steps
1. Add a single-flight guard around collectSample.
2. Prevent on-demand samples from mutating the sampler baselines (per-call snapshots).

## Acceptance
- CPU tile never shows a spurious dash under concurrent polling.
- Persisted net rates stay stable.

## Tests
- Add unit test for the single-flight guard.

