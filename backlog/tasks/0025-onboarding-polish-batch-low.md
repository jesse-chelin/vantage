# 0025 — Onboarding polish batch (low)

- severity: low
- area: onboarding
- status: ready
- depends_on: none
- files: public/app.js
- source: audit O10, O12, O13

## Summary
ComfyUI copy button copies a docs URL; Pull Ollama model is offered without Ollama; security fix links open a generic pane.

## Steps
1. Give ComfyUI a real install command or relabel the button.
2. Hide the Pull Ollama action unless ollama.installed.
3. Map each security posture id to its specific deep link.

## Acceptance
- Each of the three is corrected.

## Tests
- Manual checks per item.

