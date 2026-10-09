# Changelog

All notable changes to Vantage are documented here.
This file is generated from the git history. Refresh it with `npm run changelog`.

## Unreleased (2026-10-09)

### Fixed

- Fix dashboard not reflecting removed OpenClaw and ComfyUI ([9b323b2](https://github.com/jesse-chelin/vantage/commit/9b323b2))

### Other

- Refresh Monitor top processes every 2s via a dedicated endpoint ([6701a07](https://github.com/jesse-chelin/vantage/commit/6701a07))
- Make Quit process reliable with SIGKILL escalation and clearer confirm ([386e046](https://github.com/jesse-chelin/vantage/commit/386e046))
- Extend stat widgets across Monitor, Disk, Network, Services, Runtimes, Ollama, Brew and Security ([608ff9c](https://github.com/jesse-chelin/vantage/commit/608ff9c))
- Redesign overview stat tiles with charts and richer detail ([f7fd613](https://github.com/jesse-chelin/vantage/commit/f7fd613))
- Auto-rebuild the native app when its sources change during an update ([066d694](https://github.com/jesse-chelin/vantage/commit/066d694))
- Onboarding redesign, native macOS assets, and reset tooling ([17ba917](https://github.com/jesse-chelin/vantage/commit/17ba917))

## v0.9.0-beta (2026-10-09)

### Added

- Add GitHub release workflow for tagged versions ([9e869bf](https://github.com/jesse-chelin/vantage/commit/9e869bf))
- Add auto-generated changelog and in-app What's new view ([a899f95](https://github.com/jesse-chelin/vantage/commit/a899f95))
- Add updating overlay, live version label, and restart detection ([d7b58df](https://github.com/jesse-chelin/vantage/commit/d7b58df))
- Notify when a Vantage update is available ([16497b0](https://github.com/jesse-chelin/vantage/commit/16497b0))
- Add in-app update checking and one-click updates ([3ee14db](https://github.com/jesse-chelin/vantage/commit/3ee14db))
- Add README with screenshots ([542a59e](https://github.com/jesse-chelin/vantage/commit/542a59e))
- Add install/update scripts and document cross-Mac setup ([daa9830](https://github.com/jesse-chelin/vantage/commit/daa9830))
- Vantage: local Mac management console ([dd7b8af](https://github.com/jesse-chelin/vantage/commit/dd7b8af))
- Add read-only audit swarm: bug-hunter, security-auditor, ui-reviewer + /swarm-audit ([262709f](https://github.com/jesse-chelin/vantage/commit/262709f))
- Baseline: Vantage dashboard before agent swarm audits ([916babf](https://github.com/jesse-chelin/vantage/commit/916babf))

### Changed

- Shared updater, Beta labeling, and em-dash cleanup ([fab8796](https://github.com/jesse-chelin/vantage/commit/fab8796))
- Rebrand: drop AI-dashboard naming (Vantage, local.vantage service) ([a5e8ed7](https://github.com/jesse-chelin/vantage/commit/a5e8ed7))

### Fixed

- Fix updating overlay hanging with no feedback or escape ([b7b60d3](https://github.com/jesse-chelin/vantage/commit/b7b60d3))

### Removed

- README: remove em-dashes ([89cc9f1](https://github.com/jesse-chelin/vantage/commit/89cc9f1))

### Documentation

- Document in-app updates in README ([9178d0e](https://github.com/jesse-chelin/vantage/commit/9178d0e))
- Point docs and installer at jesse-chelin/vantage ([47563c9](https://github.com/jesse-chelin/vantage/commit/47563c9))
