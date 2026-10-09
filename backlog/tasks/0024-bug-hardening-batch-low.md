# 0024 — Bug hardening batch (low)

- severity: low
- area: bug
- status: ready
- depends_on: none
- files: server.js
- source: audit B6, B7

## Summary
serveStatic prefix check lacks a path separator; /api/ports/detail does not range-check port.

## Steps
1. Compare resolved === PUBLIC_DIR || startsWith(PUBLIC_DIR + path.sep).
2. Require an integer port in 1..65535 or return 400.

## Acceptance
- Sibling 'public*' dirs are not served; invalid ports 400.

## Tests
- Add unit tests for both.

