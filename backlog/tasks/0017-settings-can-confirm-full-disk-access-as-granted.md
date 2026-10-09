# 0017 — Settings can confirm Full Disk Access as granted

- severity: medium
- area: onboarding
- status: ready
- depends_on: none
- files: public/app.js, lib/setup.js
- source: audit O8

## Summary
/api/setup omits fullDiskAccess, so the Settings row always reads Optional even after granting.

## Steps
1. Offer the explicit Re-check on the Settings row, or persist the last probe result.

## Acceptance
- After granting FDA, the Settings row reflects it.

## Tests
- Manual: Re-check on the Settings row.

