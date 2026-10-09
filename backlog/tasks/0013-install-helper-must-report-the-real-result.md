# 0013 — Install helper must report the real result

- severity: medium
- area: onboarding
- status: ready
- depends_on: none
- files: public/app.js
- source: audit O4

## Summary
The helper install polls 40x without watching job status and shows success even when brew/install failed.

## Steps
1. Track the returned jobId; stop polling on done/failed.
2. Surface job.error; only show success when the notifier actually changed.

## Acceptance
- On a Mac without Homebrew, the button ends in an error, not a false success.

## Tests
- Manual: simulate a failing install.

