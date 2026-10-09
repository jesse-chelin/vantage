# 0021 — Announce async results and wizard step changes

- severity: medium
- area: ui
- status: ready
- depends_on: none
- files: public/app.js, public/index.html
- source: audit U5

## Summary
Permission tests, ping/port results, scan status and 'Step N of M' update elements with no aria-live.

## Steps
1. Add role=status/aria-live=polite to .wc-status, #net-probe-result, #scan-status; announce wizard step changes.

## Acceptance
- Async status changes are announced.

## Tests
- Manual: screen reader pass.

