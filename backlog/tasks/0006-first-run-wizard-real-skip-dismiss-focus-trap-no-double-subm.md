# 0006 — First-run wizard: real Skip, dismiss, focus trap, no double-submit

- severity: high
- area: onboarding
- status: ready
- depends_on: none
- files: public/app.js, public/styles.css, public/index.html
- source: audit O1, U1, U7, U8, O11

## Summary
The wizard cannot be dismissed, Skip setup just advances a step, there is no focus trap or Escape, and rapid clicks double-submit.

## Steps
1. Make Skip setup persist completedAt and close the wizard.
2. Add Escape and an explicit close affordance; return focus to the view on close.
3. Add onboardingRoot to syncScrollLock and trap focus while open.
4. Guard Continue/Skip during a transition and await persistOnboarding.
5. Persist currentStep in onboardingBack too.

## Acceptance
- Skip setup reaches the dashboard in one click.
- Escape closes the wizard, and focus returns to the dashboard.
- Tab does not reach background controls while the wizard is open.
- Rapid Continue clicks advance exactly one step and write one state.

## Tests
- Manual: fresh run, Skip, Escape, keyboard-only pass.

