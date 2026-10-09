# 0028 — Design uplift: core dashboard

- severity: low
- area: design
- status: ready
- depends_on: 0008
- files: public/app.js, public/styles.css
- source: audit design uplift 3,4,5,6

## Summary
Inconsistent empty states; mixed table/row usage; no value-change motion; Monitor density is high for its cadence.

## Steps
1. Standardize core empty states on emptyState().
2. Pick one container type per data shape.
3. Add a short value-change fade gated by reduced-motion.
4. Collapse the Monitor trends/explain behind a disclosure.

## Acceptance
- Core views feel consistent and calm.

## Tests
- Manual walkthrough.

