# 0009 — Cache clear must not be undone by in-flight memoized work

- severity: medium
- area: bug
- status: ready
- depends_on: none
- files: lib/cache.js, lib/overview.js
- source: audit B2

## Summary
memo() rewrites the entry when an in-flight computation resolves after clear(), so post-action reclaim/health can stay stale for the TTL.

## Steps
1. Add a generation/epoch to the cache; drop results whose generation is stale.
2. Do the same for overview's own cache.

## Acceptance
- Emptying Trash updates reclaimable bytes immediately, not after TTL.

## Tests
- Add cache test: clear during in-flight fn.

