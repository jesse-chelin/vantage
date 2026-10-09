# 0019 — Escape server strings in rows and tables

- severity: medium
- area: ui
- status: ready
- depends_on: none
- files: public/app.js
- source: audit U3

## Summary
Network interface rows pass iface.* raw through row(), and Security/Services interpolate port/pid raw into markup and data-*.

## Steps
1. esc() the joined interface string; esc() or numeric-coerce port/pid everywhere.

## Acceptance
- No server-provided string reaches innerHTML unescaped in these views.

## Tests
- Grep for raw interpolations in the cited functions.

