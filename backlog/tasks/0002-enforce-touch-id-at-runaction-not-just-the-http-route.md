# 0002 — Enforce Touch ID at runAction, not just the HTTP route

- severity: high
- area: security
- status: ready
- depends_on: none
- files: lib/actions.js, server.js
- source: audit S4

## Summary
The grant check lives only in POST /api/actions/:id, so rules and schedule fire danger:high actions with no grant.

## Steps
1. Move the Touch ID verification into runAction (or a wrapper every caller uses).
2. Pass the grant through from rules/schedule, or forbid danger:high actions in those configs.
3. Keep the HTTP-layer check as defence in depth.

## Acceptance
- A danger:high action invoked via schedule without a grant is refused.
- Interactive high actions still pass with a valid grant.

## Tests
- Add a test that runAction('trash.empty') without a grant is refused.

