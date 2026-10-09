# 0027 — Design uplift: onboarding

- severity: low
- area: design
- status: ready
- depends_on: 0006
- files: public/app.js, public/styles.css
- source: audit design uplift 1,2,7,8

## Summary
Welcome step is nearly empty; the wizard re-centers between steps; mixed card language; bare progress bar.

## Steps
1. Render onboardingStackChips() on the welcome step with a one-line lede.
2. Top-align the wizard body with a min-height so the header stays put.
3. Render folder grants as wizardInfoCards.
4. Add progressbar semantics and reposition the step label.

## Acceptance
- First impression shows what the app detected; steps stop jumping.

## Tests
- Manual walkthrough.

