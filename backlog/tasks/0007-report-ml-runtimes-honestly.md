# 0007 — Report ML runtimes honestly

- severity: high
- area: onboarding
- status: ready
- depends_on: none
- files: lib/scanner.js, public/app.js
- source: audit O2

## Summary
scanRuntimes pushes whisper.cpp/llama.cpp/MLX/ggml unconditionally, so Setup and the Runtimes page always claim they are installed.

## Steps
1. Only mark a runtime present when its binary/version probe succeeds.
2. Let viewRuntimes reach its empty state with install guidance when none resolve.
3. Fix missingComponents and the Get set up badge to count accordingly.

## Acceptance
- On a Mac without these tools, Runtimes shows the empty state and Setup does not mark it ready.
- With whisper.cpp installed, it is listed correctly.

## Tests
- Extend scanner tests for present/absent runtimes.

