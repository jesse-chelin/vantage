# 0016 — ComfyUI restart must target the real service label

- severity: medium
- area: onboarding
- status: ready
- depends_on: none
- files: public/app.js, lib/actions.js
- source: audit O7

## Summary
The ComfyUI view always offers restart of ai.openclaw.comfyui, which 403s for any other install.

## Steps
1. Only render the action when that label is present, or resolve the real label from the scan.

## Acceptance
- Restart works when the service exists and is absent otherwise.

## Tests
- Manual: with and without the label.

