# 0014 — Setup Open for not-installed components must not dead-end

- severity: medium
- area: onboarding
- status: ready
- depends_on: none
- files: public/app.js
- source: audit O5

## Summary
data-goto plus the available() gate silently redirects ComfyUI/OpenClaw setup rows to Overview, hiding their install guidance.

## Steps
1. For not-installed components, link to the install steps inline, or let the empty state render.

## Acceptance
- Clicking Open on a not-installed component shows how to install it.

## Tests
- Manual: Setup, click Open on a missing component.

