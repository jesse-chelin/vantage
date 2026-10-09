# 0023 — Security hardening batch (low)

- severity: low
- area: security
- status: ready
- depends_on: none
- files: server.js, lib/webauthn.js, lib/network.js, lib/store.js, lib/packages.js
- source: audit S5-S10

## Summary
Token rotation, constant-time compare, fresh-sample rate limiting, option injection, path-prefix/symlink reads, and webauthn grant hardening.

## Steps
1. Rotate the token per run (or document the persistent token accurately).
2. Use crypto.timingSafeEqual for the token compare.
3. Rate-limit /api/metrics/live?fresh=1.
4. Reject host/name tokens starting with '-'.
5. Anchor prefix checks with path.sep and resolve realpath on read routes.
6. WebAuthn: check signCount, bind grants to actionId + single use, require UV at registration.

## Acceptance
- Each item is addressed or explicitly deferred with a note.

## Tests
- Unit tests for the prefix check and option validation.

