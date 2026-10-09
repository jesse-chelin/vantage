---
description: Show the Vantage backlog, or implement one task (e.g. /backlog, /backlog next, /backlog 0007).
agent: build
---

The team's priority is to **lock down onboarding and the core management
dashboard before any new features**. The backlog is the queue for that work.

Always start by showing state:

- Run `node bin/backlog.js` (overview + recommended next task).
- If `$ARGUMENTS` is empty or `list`, also run `node bin/backlog.js list --ready`
  and stop there.

If `$ARGUMENTS` is `next` or a task id (e.g. `0007`), implement that single task:

1. Launch the **backlog-worker** subagent and tell it which task id to do (or
   `next`). It reads `.opencode/agents/backlog-worker.md` and follows it.
2. Let the worker read the brief, implement the smallest correct change, run
   `npm test`, update the task status via the CLI, and commit.
3. Report what it changed, the test result, and the new status.

Do **not** implement more than one task in a single invocation, and do not add
features. If new work surfaces, add it to `backlog.json` with
`node bin/backlog.js validate && node bin/backlog.js render`.
