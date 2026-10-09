# 0005 — Fix unhandled stream errors that can crash the server

- severity: high
- area: bug
- status: ready
- depends_on: none
- files: server.js
- source: audit B1

## Summary
createReadStream(...).pipe(res) has no error handler on the source; a file vanishing between stat and open throws an uncaught exception.

## Steps
1. Use stream.pipeline for static and image/icon/gallery responses.
2. Or attach an 'error' handler that ends/destroys the response.

## Acceptance
- A read error on a served file does not exit the process.
- The request fails cleanly (404/500) instead of crashing.

## Tests
- Add a test simulating an unreadable file path.

