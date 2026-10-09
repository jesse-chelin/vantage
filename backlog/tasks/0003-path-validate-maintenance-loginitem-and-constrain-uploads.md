# 0003 — Path-validate maintenance.loginItem and constrain uploads

- severity: high
- area: security
- status: ready
- depends_on: none
- files: lib/maintenance.js, lib/actions.js, server.js
- source: audit S2

## Summary
A traversal in loginItem plus /api/upload turns the token into arbitrary code execution via launchctl bootstrap.

## Steps
1. Reject any login-item name that is not a single segment directly inside ~/Library/LaunchAgents.
2. Assert dirname(resolved) === LA_DIR before existence/bootstrap.
3. Constrain what /api/upload may store and how it can be referenced.

## Acceptance
- name: '../../x' and absolute paths are rejected.
- A plist outside ~/Library/LaunchAgents cannot be bootstrapped.

## Tests
- Add unit test for the loginItem name guard.

