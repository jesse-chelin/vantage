# 0026 — UI robustness batch (low)

- severity: low
- area: ui
- status: ready
- depends_on: none
- files: public/app.js
- source: audit U9, U10, U11

## Summary
Disk refresh error discards the view; context-menu listener can re-add after removal; overlapping poll responses have no sequence guard.

## Steps
1. Keep prior disk content and overlay an inline error/retry; set aria-busy.
2. Register the context-menu close listener synchronously or track the pending timer.
3. Add a monotonic token to drop stale poll responses.

## Acceptance
- Each item addressed; no regressions in Disk/Monitor.

## Tests
- Manual checks.

