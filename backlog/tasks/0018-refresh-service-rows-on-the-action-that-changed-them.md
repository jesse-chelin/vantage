# 0018 — Refresh service rows on the action that changed them

- severity: medium
- area: ui
- status: ready
- depends_on: none
- files: public/app.js
- source: audit O9

## Summary
After Start/Stop/Restart the Services list is not re-rendered; rows stay stale until the next rescan.

## Steps
1. In refreshAfterAction for services, re-render the list (or patch the affected row) in addition to loadHealth().

## Acceptance
- Stopping a service updates its row within a second.

## Tests
- Manual: stop a service, watch the row.

