# 0008 — Live views: preserve filter and keyboard focus across polls

- severity: high
- area: ui
- status: ready
- depends_on: none
- files: public/app.js
- source: audit B3, U2

## Summary
Monitor/Network polls replace whole subtrees, wiping the active filter and any focused control every 2-5s.

## Steps
1. Re-apply the active filter after each live re-render (loadMonitor, refreshProcRows, loadNetwork).
2. Skip the re-render while the subtree contains document.activeElement, or patch only changed values.
3. Re-target the row cursor after a re-render.

## Acceptance
- A typed filter survives Monitor and Network polls.
- Focus on a process Quit/Details button or range control is not stolen by a poll.

## Tests
- Manual: type a filter on Monitor, wait 5s, confirm it holds.

