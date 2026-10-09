# 0011 — Bound pollJob retries and resolve orphaned jobs

- severity: medium
- area: bug
- status: ready
- depends_on: none
- files: public/app.js
- source: audit B5

## Summary
pollJob retries every 2s forever on a 404 after a server restart, leaving the job 'running' and the wake lock held.

## Steps
1. Add backoff and a retry cap.
2. On a non-transient error (404), mark the job failed/removed and stop.

## Acceptance
- Restarting the server with a job open resolves the dock entry within a few seconds.

## Tests
- Manual: start a job, restart the service, watch the dock clear.

