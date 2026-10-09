# 0001 — Validate Host and block cross-site requests

- severity: critical
- area: security
- status: ready
- depends_on: none
- files: server.js
- source: audit S1

## Summary
The dashboard token is returned by an unauthenticated /api/session and is protected only by an Origin-vs-Host check that DNS rebinding defeats.

## Steps
1. Reject any request whose Host is not localhost, 127.0.0.1, [::1], or the configured HOST.
2. Reject requests with Sec-Fetch-Site: cross-site.
3. Stop deriving the expected origin from req.headers.host; compare against the fixed allowlist.
4. Review /api/session: keep the loopback bootstrap, but do not hand the token to a non-allowlisted host.

## Acceptance
- A request with Host: evil.example is rejected with 403 before any route runs.
- Sec-Fetch-Site: cross-site is rejected.
- Legitimate localhost/127.0.0.1 requests are unaffected.

## Tests
- Add test/host-guard.test.js covering allowed and rejected hosts.

