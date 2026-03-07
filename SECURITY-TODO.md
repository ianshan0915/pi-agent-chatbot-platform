# Security TODO

Deferred audit findings that require more complex changes. Track and prioritize these for future PRs.

## Deferred Items

- [ ] **Persistent account lockout** — Move in-memory `failedAttempts` Map to Redis/DB (currently resets on server restart)
- [ ] **Persistent OAuth PKCE state** — Move in-memory Map to Redis (required for multi-instance deployments)
- [ ] **WebSocket message rate limiting** — Per-connection throttle to prevent message flood attacks
- [ ] **Token revocation / logout** — JWT blacklist in Redis for immediate session invalidation
- [ ] **File upload rate limiting** — Per-user limit on POST /api/files (currently uses general API rate limit)
- [ ] **Bulk import size limits** — Cap message count and payload size on POST /api/import
- [ ] **CSP: remove unsafe-inline** — Requires nonce-based approach (significant frontend change with Lit.js)
