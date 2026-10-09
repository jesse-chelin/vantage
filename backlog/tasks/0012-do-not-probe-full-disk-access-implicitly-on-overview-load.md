# 0012 — Do not probe Full Disk Access implicitly on Overview load

- severity: medium
- area: onboarding
- status: ready
- depends_on: none
- files: lib/overview.js, server.js, lib/setup.js
- source: audit O3

## Summary
overview.report() reads ~/Library/Safari|Mail on load, which can fire the macOS TCC prompt before onboarding explains it.

## Steps
1. Remove the FDA probe from the default report path.
2. Gate it behind the explicit, explained action the wizard already uses.
3. Reuse the wizard's recorded state where possible.

## Acceptance
- Loading Overview never triggers the 'access data from other apps' prompt on first run.

## Tests
- Manual: fresh run, confirm no TCC prompt before the macOS access step.

