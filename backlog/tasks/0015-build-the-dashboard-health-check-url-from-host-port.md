# 0015 — Build the dashboard health check URL from HOST/PORT

- severity: medium
- area: bug
- status: ready
- depends_on: none
- files: lib/health.js
- source: audit O6

## Summary
The dashboard health check hardcodes port 8790, so under the documented PORT override it reports the dashboard as down.

## Steps
1. Derive the URL from the configured HOST/PORT.

## Acceptance
- Running on a non-default port does not report the dashboard as down.

## Tests
- Start on an alternate port and confirm the dashboard check passes.

