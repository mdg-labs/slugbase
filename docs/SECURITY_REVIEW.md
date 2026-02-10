# SlugBase Security Review Report

**Date:** February 2025  
**Scope:** Full-stack (React/TypeScript frontend, Node/Express/TypeScript backend)  
**Methodology:** OWASP ASVS / Top 10–guided audit; architecture mapping; code and config review

---

## Executive Summary

SlugBase implements solid security foundations: parameterized queries throughout, CSRF protection on state-changing operations, rate limiting, Helmet headers, and consistent ownership checks on bookmarks, folders, and tags. Authentication uses JWT (and in CLOUD mode, short-lived access tokens with hashed refresh tokens and rotation). The redirect endpoint does not accept user-controlled URLs and validates stored bookmark URLs to http/https only, limiting open-redirect risk.

**Critical or high-impact issues identified:** JWT verification does not explicitly restrict the signing algorithm (algorithm confusion / `alg:none` risk), and password-reset tokens are stored in plaintext in the database. Medium and lower findings include: contact form PII in logs and missing input limits, missing strict rate limit on redirect endpoint, CORS allowing requests with no `Origin`, session secret fallback, and a few data-integrity/authorization refinements (tag ownership on bookmark create/update, bookmark import DoS cap).

**Recommendation:** Address the two high-priority items (JWT algorithm restriction, hash password-reset tokens) in the next release; then work through the remediation plan below for medium and low items and ongoing hygiene.

---

## Architecture Summary (as implemented)

### Authentication & session

- **Local auth:** `POST /api/auth/login` (email/password) → bcrypt compare; JWT or access+refresh (CLOUD) set via httpOnly cookies.
- **OIDC:** `GET /api/auth/:provider`, `GET /api/auth/:provider/callback`; express-session (DB store) for OAuth state; on success, JWT (or access+refresh in CLOUD) set, session destroyed.
- **JWT:** Issued by `utils/jwt.ts` (HS256 implied by default); verified by Passport JWT strategy in `auth/jwt.ts`; token from cookie `token` or `Authorization: Bearer`.
- **Refresh (CLOUD):** `POST /api/auth/refresh`; refresh token in httpOnly cookie; `utils/refresh-token.ts` hashes token in DB, rotates on use, revokes on logout.
- **Logout:** `POST /api/auth/logout` clears cookies and revokes all refresh tokens for the user (CLOUD).

### Core entities and access model

- **Users:** `users` table; `user_key` for public forwarding paths; admin via `is_admin`.
- **Bookmarks:** `bookmarks` (user_id, slug, url, forwarding_enabled); ownership and sharing via `bookmark_user_shares`, `bookmark_team_shares`, and folder-based sharing (`bookmark_folders` + `folder_user_shares` / `folder_team_shares`).
- **Folders / Tags:** Per-user; folders/tags shared via team or user share tables.
- **Teams:** `teams` + `team_members`; team-scoped shares for bookmarks and folders.

### Key endpoints

| Area        | Endpoints |
|------------|-----------|
| Auth       | `/api/auth/login`, `/logout`, `/refresh`, `/me`, `/setup`, `/setup/status`, `/providers`, `/:provider`, `/:provider/callback` |
| Password   | `/api/password-reset/request`, `/verify`, `/reset` |
| Email      | `/api/email-verification/verify`, `/confirm` |
| Resources  | `/api/bookmarks`, `/api/folders`, `/api/tags`, `/api/teams`, `/api/users/me`, `/api/dashboard/stats` |
| Admin      | `/api/admin/users`, `/api/admin/teams`, `/api/admin/settings`, `/api/admin/demo-reset` |
| Public     | `GET /:user_key/:slug` (redirect), `/api/health`, `/api/version`, `/api/contact` (CLOUD) |
| CSRF       | `GET /api/csrf-token` |

---

## Findings by Severity

### Critical

*None identified.*

---

### High

#### H1. JWT verification does not restrict signing algorithm

- **Impact:** Algorithm confusion or acceptance of `alg:none` (if ever supported by a dependency) could allow token forgery and full account takeover.
- **Scenario:** Attacker provides a JWT with `alg: none` or uses a different algorithm with a key the server might treat as valid.
- **Evidence:**  
  - `backend/src/auth/jwt.ts`: Passport JwtStrategy uses `secretOrKey: JWT_SECRET` with no `algorithms` option.  
  - `backend/src/utils/jwt.ts`: `verifyToken()` calls `jwt.verify(token, JWT_SECRET)` with no `algorithms` option.
- **Fix:**  
  - In `auth/jwt.ts`, add `algorithms: ['HS256']` to the JwtStrategy options.  
  - In `utils/jwt.ts`, use `jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] })`.
- **Verification:** Unit test that tokens with `alg: none` or `alg: RS256` are rejected; only HS256 tokens with correct secret are accepted.

---

#### H2. Password-reset tokens stored in plaintext

- **Impact:** Database compromise exposes all active reset tokens; attacker can take over accounts.
- **Scenario:** Attacker gains read access to DB (backup, SQL injection elsewhere, insider) and uses `password_reset_tokens.token` to reset victims’ passwords.
- **Evidence:**  
  - `backend/src/routes/password-reset.ts`: Token generated with `crypto.randomBytes(32).toString('hex')` and stored in `password_reset_tokens` via `execute('INSERT INTO password_reset_tokens (id, user_id, token, expires_at)...', [..., token, ...])`.  
  - Schema: `password_reset_tokens.token` is plaintext.
- **Fix:**  
  - Add a `token_hash` column (e.g. SHA-256 of token); store only the hash; keep sending the plain token once by email.  
  - On verify/reset, hash the submitted token and look up by `token_hash`.  
  - Mirror the pattern used in `utils/refresh-token.ts` (hash-only storage).
- **Verification:** DB migration and tests: reset flow still works; only the hash is stored; old plaintext column removed after migration.

---

### Medium

#### M1. Contact form logs PII and has no input limits or rate limit

- **Impact:** PII (name, email, message) in logs; log aggregation/misuse or compliance issues; DoS via huge payloads or high request rate.
- **Scenario:** Attacker or misconfiguration sends large body or many requests; logs contain full contact content and identifiers.
- **Evidence:**  
  - `backend/src/routes/contact.ts`: `console.log('[Contact]', { name, email, message: (message as string).slice(0, 200) });` — no length validation on name/email/message; only general rate limiter applies.
- **Fix:**  
  - Do not log PII. Log only a non-identifying descriptor (e.g. "Contact form submitted", timestamp, optional request id).  
  - Validate and cap lengths (e.g. name ≤255, email ≤255, message ≤10k).  
  - Apply a stricter rate limiter to `POST /api/contact` (e.g. 10/hour per IP).
- **Verification:** Confirm logs contain no name/email/message; reject oversized input; verify rate limit with script.

---

#### M2. CORS allows requests with no Origin

- **Impact:** Non-browser clients (Postman, mobile) are intentionally allowed; if credentials are sent from a context that omits Origin, the request is allowed. Slightly increases risk of misconfiguration in multi-origin setups.
- **Evidence:** `backend/src/index.ts`: `if (!origin) return callback(null, true);`
- **Fix:** Document that this is intentional for non-browser clients. Optionally, in production, only allow no-origin for specific paths (e.g. health) or require a custom header for non-browser API access instead of relying on missing Origin.
- **Verification:** With credentials, browser requests from a disallowed origin are still rejected; non-browser clients without Origin still work as designed.

---

#### M3. Session secret fallback

- **Impact:** If `SESSION_SECRET` is unset, code falls back to `JWT_SECRET` and then to a hardcoded string. Same secret for JWT and session weakens key separation; default string is unsafe if both are missing.
- **Evidence:** `backend/src/index.ts`: `const sessionSecret = process.env.SESSION_SECRET || process.env.JWT_SECRET || 'slugbase-session-secret-change-in-production';`
- **Fix:** Require `SESSION_SECRET` in production (e.g. in env validation), or generate a runtime secret and log a warning when unset. Do not use JWT_SECRET as session secret in production.
- **Verification:** Production startup fails or warns when SESSION_SECRET is unset; staging/prod use a distinct SESSION_SECRET.

---

#### M4. Redirect endpoint rate limit may be high for abuse

- **Impact:** Redirect URL is not user-supplied (good), but the endpoint can be used to amplify traffic to victim sites or for link-checking bots; 500/15min per IP may be high for a single endpoint.
- **Evidence:** `backend/src/index.ts`: Redirect route uses `strictRateLimiter` (500/15min).
- **Fix:** Consider a dedicated rate limiter for `GET /:user_key/:slug` (e.g. 100–200/15min per IP) to reduce abuse and crawler load.
- **Verification:** Verify limit with repeated requests; ensure legitimate use (e.g. a few redirects per user per minute) is not blocked.

---

#### M5. Production error handler can expose status codes and messages

- **Impact:** Some error paths may still return `err.message` or status in production, leaking internal or constraint info.
- **Evidence:** `backend/src/middleware/error-handler.ts`: In production, `if (err.statusCode)` returns `err.message`. Database UNIQUE/duplicate is normalized to a generic message; other errors become "Internal server error".
- **Fix:** In production, never send `err.message` or stack to the client. Use a generic message for all 5xx; for 4xx from the app, use a fixed message per status (e.g. "Bad request", "Not found") and log the real message server-side only.
- **Verification:** Trigger DB/validation errors in production mode; confirm response body and headers contain no stack or internal messages.

---

### Low

#### L1. Bookmark create/update does not validate tag ownership

- **Impact:** User can pass another user’s tag IDs; bookmark_tags would link the bookmark to tags the user does not own, causing inconsistent UI or leakage of tag existence/names in some views.
- **Evidence:** `backend/src/routes/bookmarks.ts`: In POST and PUT, `data.tag_ids` are used in `INSERT INTO bookmark_tags` without checking `tags.user_id = ?`.
- **Fix:** For each `tag_id` in create/update, ensure `tag.user_id === userId` (or that the tag is otherwise allowed). Reject with 403 if any tag is not owned by the user.
- **Verification:** As a non-owner, send another user’s tag_id in create/update; expect 403 and no new bookmark_tags row.

---

#### L2. Bookmark import has no cap on array size

- **Impact:** A very large `bookmarks` array in one request could cause high CPU/memory and long locks (DoS).
- **Evidence:** `backend/src/routes/bookmarks.ts`: `router.post('/import', ...)` uses `if (!Array.isArray(importBookmarks))` but does not cap `importBookmarks.length`.
- **Fix:** Reject with 400 if `importBookmarks.length > 1000` (or another defined limit), and document the limit.
- **Verification:** Send import with 1001 items; expect 400 and no DB writes.

---

#### L3. Password-reset verify response distinguishes invalid vs expired

- **Impact:** Slight information leak: an attacker can distinguish "invalid token" from "expired token" via response body or timing. Token entropy is high so enumeration is not practical; this is low.
- **Evidence:** `backend/src/routes/password-reset.ts`: Verify returns different messages for missing/invalid token vs expired.
- **Fix:** Use a single generic message for both invalid and expired (e.g. "Invalid or expired token") while keeping 400.
- **Verification:** Call verify with invalid token and with expired token; response message is the same.

---

#### L4. SESSION_SECRET not validated at startup

- **Impact:** Session cookie could be signed with a weak or default secret if operators forget to set it.
- **Evidence:** `backend/src/utils/env-validation.ts`: Validates JWT_SECRET and ENCRYPTION_KEY; SESSION_SECRET only triggers a warning.
- **Fix:** In production, require SESSION_SECRET (or fail startup) so session signing never falls back to JWT_SECRET or default.
- **Verification:** Start in production without SESSION_SECRET; expect failure or clear warning and no use of default.

---

### Informational

- **Refresh tokens:** Stored as SHA-256 hash; rotation on use; revocation on logout; expiry and cookie options (httpOnly, secure, SameSite) are appropriate.  
- **Redirect endpoint:** Redirect URL comes from DB (bookmark.url), validated with `validateUrl` (http/https only, no javascript/data). No user-controlled redirect; open-redirect risk is low. Phishing via malicious bookmark URLs is inherent to the feature; consider an interstitial or safe-browsing check as a product decision.  
- **CSRF:** State-changing methods protected; token in cookie + header/body; auth endpoints that must be cross-site (password-reset, OIDC callback, refresh, contact) correctly excluded.  
- **Authorization:** Bookmark/folder/tag GET/PUT/DELETE enforce ownership or share; admin routes use `requireAdmin()`.  
- **SQL:** Queries use parameterized APIs; no string concatenation of user input into SQL.  
- **XSS:** No `dangerouslySetInnerHTML`/innerHTML in frontend; titles/names sanitized with `sanitizeString` on backend.  
- **Helmet:** CSP, HSTS when HTTPS, and other headers configured; `X-Frame-Options` (via Helmet) mitigates clickjacking.

---

## Threat Model (concise)

### Assets

- User accounts (credentials, profile, preferences).  
- Bookmarks, folders, tags, and sharing/team data.  
- Admin capability (user/team management, settings).  
- OIDC client secrets (encrypted at rest).  
- Session and JWT/refresh tokens.

### Actors

- **End users:** Authenticated; operate on own and shared data.  
- **Admins:** Full access to users/teams/settings.  
- **Unauthenticated:** Setup (if not initialized), login, password reset, OIDC flow, redirect (public), health, contact (CLOUD).  
- **Attacker:** External or compromised client; no assumption of server compromise.

### Trust boundaries

- Browser ↔ Frontend (SPA): Trusted for same-origin; CORS and cookies define cross-origin trust.  
- Frontend ↔ Backend API: Authenticated via JWT (cookie or Bearer); CSRF for state-changing.  
- Backend ↔ DB: Full trust (parameterized queries; DB credentials in env).  
- Backend ↔ OIDC provider: TLS; trust issuer for identity.  
- Backend ↔ Email (SMTP): Outbound only; trust env config.

### Attack surfaces

- **Authentication:** Login, OIDC, refresh, logout, setup, password reset, email verification.  
- **API:** All CRUD and search/export/import; admin endpoints.  
- **Public:** Redirect (`/:user_key/:slug`), contact form.  
- **Session:** Express session for OAuth only; stored in DB.

### Threats considered

- **Credential theft:** Mitigated by bcrypt, httpOnly cookies, HTTPS in prod; improved by hashing reset tokens and restricting JWT alg.  
- **IDOR:** Mitigated by ownership/share checks on bookmarks, folders, tags; tag_ids on create/update should be validated (L1).  
- **CSRF:** Mitigated by CSRF token and SameSite cookies.  
- **XSS:** Mitigated by React escaping and server-side sanitization.  
- **Open redirect:** Low; redirect uses stored URL and validateUrl.  
- **Injection:** SQL mitigated by parameterized queries; no user input in raw SQL.  
- **Secrets:** JWT/session/encryption keys from env; avoid default and reuse (M3, L4).

---

## Remediation Plan (90 days)

### Phase 1 — Quick wins (0–30 days)

1. **H1 – JWT algorithm:** Add `algorithms: ['HS256']` in `auth/jwt.ts` and `utils/jwt.ts`; add tests.  
2. **H2 – Password-reset tokens:** Design migration (add token_hash, backfill or one-time use), store only hash, update verify/reset logic.  
3. **M1 – Contact:** Remove PII from logs; add length validation and stricter rate limit.  
4. **M3 / L4 – Session secret:** Require SESSION_SECRET in production in env validation; remove or narrow fallback.  
5. **L2 – Import cap:** Enforce max 1000 (or chosen limit) on import array; return 400 when exceeded.  
6. **L3 – Password reset message:** Unify invalid/expired message in verify endpoint.

### Phase 2 — Hardening (30–60 days)

7. **M5 – Error handler:** Audit all production branches; ensure no err.message or stack in responses.  
8. **M4 – Redirect rate limit:** Add redirect-specific rate limiter and tune.  
9. **L1 – Tag ownership:** Validate tag ownership (or allowed scope) for bookmark create/update tag_ids.  
10. **M2 – CORS:** Document no-Origin behavior; optionally restrict to specific paths or add a non-browser auth pattern.  
11. **Dependencies:** Run `npm audit` (backend + frontend); fix high/critical; pin versions and schedule quarterly audits.  
12. **CSP:** Tighten if possible (e.g. remove `'unsafe-inline'` for styles where feasible).

### Phase 3 — Ongoing (60–90 days and beyond)

13. **Security checklist:** Adopt the checklist below for every release.  
14. **Logging:** Ensure no tokens or PII in logs; consider structured logging and redaction.  
15. **Infrastructure:** Document assumptions (Cloud Run, Cloud SQL, Cloudflare Pages, reverse proxy); TLS and secret injection.  
16. **OIDC:** Consider issuer/audience validation and clock skew if not already enforced by library.  
17. **Refresh token:** Optional: detect reuse (e.g. use-after-rotate) and revoke all tokens for that user.

---

## Security Checklist

### Pre-release (every release)

- [ ] No new endpoints without auth/authorization and (where applicable) CSRF.  
- [ ] New/updated inputs validated and length-limited; output encoded/sanitized.  
- [ ] No raw SQL with user input; only parameterized queries.  
- [ ] No PII or secrets in logs or error responses.  
- [ ] `npm audit` run; high/critical addressed or accepted with justification.  
- [ ] Env validation: JWT_SECRET, ENCRYPTION_KEY (and SESSION_SECRET in prod) required and strong.  
- [ ] Production build tested; NODE_ENV=production does not expose stack or internal messages.

### Recurring (e.g. quarterly)

- [ ] Dependency audit and upgrade plan; pin versions.  
- [ ] Review CORS and CSRF exclusion list for new endpoints.  
- [ ] Review rate limits (auth, password reset, contact, redirect, expensive search).  
- [ ] Confirm password-reset and email-verification tokens are hashed and single-use.  
- [ ] Confirm refresh token rotation and revocation on logout.  
- [ ] Review admin and high-privilege endpoints for access control.  
- [ ] Check for new `dangerouslySetInnerHTML` or eval in frontend.  
- [ ] Re-run this security review checklist and update SECURITY.md.

### After incident or major feature

- [ ] Threat model updated if new assets or flows.  
- [ ] New flows (e.g. new auth or sharing) reviewed for IDOR and injection.  
- [ ] SECURITY.md and SECURITY_REVIEW.md updated with new assumptions and mitigations.

---

*End of Security Review Report*
