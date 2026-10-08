---
description: Launch the read-only Vantage audit swarm (bug-hunter + security-auditor + ui-reviewer) in parallel and merge findings into one ranked report.
agent: build
---

Orchestrate a **read-only** audit swarm over the Vantage app in the current
working directory. No application file may be modified.

Scope: $ARGUMENTS
(If the scope above is empty, audit the entire application.)

Do this in order:

1. **Fan out — launch all three subagents in parallel**, each with
   `background: true`, in a single batch of calls:
   - `bug-hunter`
   - `security-auditor`
   - `ui-reviewer`

   Give each a complete, self-contained prompt: the scope above, the app layout
   (`server.js`, `lib/`, `public/app.js`, `public/styles.css`,
   `public/index.html`, `test/`), and an explicit reminder that it is read-only
   (no edits, no shell).

2. **Wait** for all three to report back. If one fails, note it and continue.

3. **Merge** the three result sets into a single report:
   - de-duplicate overlapping findings and keep the highest severity;
   - order by severity (critical → low), then by confidence;
   - keep concrete `path:line` references;
   - put the UI reviewer's subjective "design uplift" items in a clearly
     separate section.

4. **Persist** the merged report to `reports/audit-<YYYY-MM-DD>.md` (create the
   directory if needed), with a short header stating scope, date, and the three
   agents used.

5. **Summarize in chat**: the top findings with severities, the overall count,
   and the report path.

Do not fix anything in this run — this is discovery only. Do not modify
`server.js`, `lib/`, `public/`, or `test/`.
