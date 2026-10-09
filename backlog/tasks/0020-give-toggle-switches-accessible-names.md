# 0020 — Give toggle switches accessible names

- severity: medium
- area: ui
- status: ready
- depends_on: none
- files: public/app.js
- source: audit U4

## Summary
switchRow, settings booleans and wizard toggles render an unlabeled checkbox.

## Steps
1. Add aria-label or aria-labelledby pointing at the row title for every toggle input.

## Acceptance
- A screen reader announces each toggle with its label.

## Tests
- Manual: VoiceOver over Settings toggles.

