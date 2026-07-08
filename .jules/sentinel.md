## 2025-05-14 - GitLab Webhook DoS and Timing Attack Hardening
**Vulnerability:** Unauthenticated DoS via DB lookups and potential timing attack on webhook token comparison.
**Learning:** GitLab webhooks send the token in plaintext, unlike GitHub's HMAC signatures. Comparing these tokens directly with `timingSafeEqual` is only safe if they have the same length, otherwise it throws. Also, missing an early token check allowed unauthenticated requests to trigger database lookups.
**Prevention:** Always check for auth headers before performing database work. Use HMAC/SHA-256 to hash tokens before comparison to ensure fixed-length, timing-safe validation.

## 2025-05-14 - Repository Resolution TypeError (Crash/DoS)
**Vulnerability:** `TypeError` (cannot read property 'startsWith' of null) in `/api/repos/resolve`.
**Learning:** The `repos.find` loop assumed all repositories have a `path`. In v1, remote repositories have a null `path` (they use `localPath` for clones), causing a crash when `dir.startsWith(r.path)` is called.
**Prevention:** Always null-check optional fields from the database before calling string methods on them, especially in loops that iterate over all records.
