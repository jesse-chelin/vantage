# Issue tracker: Local backlog CLI

Issues and specs for this repo live in the local `backlog/` queue, driven by
`node bin/backlog.js`. This is a custom tracker — not GitHub Issues — even though
the git remote points at GitHub.

## Source of truth

- `backlog/backlog.json` — all tasks. Edit this (or use the CLI) and re-render.
- `backlog/STATUS.md` — generated index. Do not edit by hand.
- `backlog/tasks/<id>-<slug>.md` — generated briefs. Do not edit by hand.

## Conventions

- **Create a task**: append an object to `tasks` in `backlog/backlog.json` with
  the fields below, then `node bin/backlog.js validate && node bin/backlog.js render`.
- **Read a task**: `node bin/backlog.js show <id>`.
- **List tasks**: `node bin/backlog.js list [--ready] [--status S] [--area A] [--severity S]`.
- **Next task**: `node bin/backlog.js next` (highest-priority `ready` task whose
  dependencies are `done`).
- **Claim a task**: `node bin/backlog.js set <id> in-progress`.
- **Resolve a task**: `node bin/backlog.js set <id> done` (or `blocked` with a
  one-line reason).
- **Regenerate**: `node bin/backlog.js render`.

## Task fields

| field | meaning |
| --- | --- |
| `id` | zero-padded, stable, referenced in commits |
| `title` | imperative, one line |
| `severity` | `critical` \| `high` \| `medium` \| `low` |
| `area` | `security` \| `bug` \| `onboarding` \| `ui` \| `design` |
| `status` | `ready` \| `in-progress` \| `blocked` \| `done` \| `wontfix` |
| `depends_on` | ids that must be `done` first |
| `files` | files the change should touch |
| `source` | the audit finding(s) it came from |
| `summary` | why it matters, one sentence |
| `steps` | the intended implementation |
| `acceptance` | how we know it is done |
| `tests` | verification to run/add |

## When a skill says "publish to the issue tracker"

Add a task to `backlog/backlog.json` (fields above), then `validate` and `render`.

## When a skill says "fetch the relevant ticket"

Run `node bin/backlog.js show <id>`, or read `backlog/tasks/<id>-<slug>.md`.

## Wayfinding operations

Used by `/wayfinder`. This tracker has no native map concept. Represent a map as
a task and its child tickets as tasks with `depends_on` pointing at the map's id;
or fall back to the `.scratch/<effort>/` markdown convention for that effort.
Blocking is the task's `depends_on`: a ticket is unblocked when every id it lists
is `done` or `wontfix`.

## Working a task

1. `node bin/backlog.js next` (or take an explicit id).
2. `node bin/backlog.js show <id>`, then read the cited files.
3. `node bin/backlog.js set <id> in-progress`.
4. Make the smallest correct change — no unrelated refactors or new features.
5. Run `npm test` and add the tests the brief asks for.
6. `node bin/backlog.js set <id> done` (or `blocked` with a reason).
7. Commit with the id in the message, e.g. `0002: enforce Touch ID in runAction`.
