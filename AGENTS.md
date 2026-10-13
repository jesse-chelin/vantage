# Vantage — agent guide

## Agent skills

### Issue tracker

Work is tracked in the local `backlog/` queue (`backlog/backlog.json` + generated briefs, driven by `node bin/backlog.js`), not GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: `GLOSSARY.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
