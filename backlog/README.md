# Vantage backlog

An agent-friendly work queue. One structured store, a CLI to drive it, and one
Markdown brief per task. The current focus is to **lock down onboarding and the
core management dashboard before adding features**.

## Source of truth

- `backlog.json` — all tasks. Edit this (or use the CLI) and re-render.
- `STATUS.md` — generated index. Do not edit by hand.
- `tasks/<id>-<slug>.md` — generated briefs. Do not edit by hand.

Regenerate everything from the store:

```sh
node bin/backlog.js render
```

## Working the queue

```sh
node bin/backlog.js                      # overview + the recommended next task
node bin/backlog.js list                 # all tasks, priority order
node bin/backlog.js list --ready         # only unblocked, ready tasks
node bin/backlog.js list --area security # filter by area/severity/status
node bin/backlog.js next                 # full brief for the next task
node bin/backlog.js show 0002            # one task brief
node bin/backlog.js set 0002 in-progress # claim it
node bin/backlog.js set 0002 done        # finish it
```

`*` next to a task in `list` means it is blocked by an unfinished dependency.

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

Severity order is `critical > high > medium > low`; within a severity, lower id
first. `next` returns the highest-priority `ready` task whose dependencies are
`done`.

## How an agent should work one task

1. `node bin/backlog.js next` (or take an explicit id).
2. `node bin/backlog.js show <id>` and read the brief, then read the cited files.
3. `node bin/backlog.js set <id> in-progress`.
4. Make the **smallest correct change**. No unrelated refactors, no new features,
   no scope creep. Keep the public behaviour and README in sync if you change it.
5. Run `npm test`. Add the tests the brief asks for. Fix any regression you cause.
6. `node bin/backlog.js set <id> done` (or `blocked` with a one-line reason if you
   cannot finish). `render` runs automatically.
7. Commit with the id in the message, e.g. `0002: enforce Touch ID in runAction`.

One task per commit where practical, so a failure is easy to revert.

## Order of work

1. **Security floor:** 0001 → 0003 → 0004 → 0002.
2. **First-run lockdown:** 0006, 0007, 0012, 0014, 0013, 0017.
3. **Core-loop correctness:** 0005, 0008, 0009, 0010, 0011, 0015, 0018, 0019.
4. **Polish and batches:** 0020–0028.

Do not start a task whose `depends_on` are not `done`; the CLI marks those with
`*`.

## Adding a task

Append an object to `tasks` in `backlog.json` with the fields above, then
`node bin/backlog.js validate && node bin/backlog.js render`.
