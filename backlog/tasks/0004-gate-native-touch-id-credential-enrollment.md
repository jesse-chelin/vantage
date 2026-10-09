# 0004 — Gate native Touch ID credential enrollment

- severity: high
- area: security
- status: ready
- depends_on: none
- files: server.js, lib/webauthn.js
- source: audit S3

## Summary
native/register accepts any token-supplied public key, so a token holder can mint the second factor.

## Steps
1. Require a server-issued registration challenge plus an existing-credential assertion before enrolling a native key.
2. Or require a one-time bootstrap secret that only the local native app can obtain.
3. Never let a plain token add a credential.

## Acceptance
- native/register without a valid ceremony is rejected.
- Enrolling the first credential on a fresh install still works.

## Tests
- Add test that token-only native/register is refused.

