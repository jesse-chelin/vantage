# 0022 — Overview extras: show an error and retry instead of blanking

- severity: medium
- area: ui
- status: ready
- depends_on: none
- files: public/app.js
- source: audit U6

## Summary
loadOverviewExtras catches to null and blanks the health card/checklist with no error or retry.

## Steps
1. Render an error empty-state with a Retry button when the overview/series fetch fails.

## Acceptance
- A failed extras load shows an error with a working Retry.

## Tests
- Manual: block the request and reload.

