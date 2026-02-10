# Security Review – Status Summary

**Last updated:** February 2025 (all recommendations implemented)  
**Reference:** [SECURITY_REVIEW.md](./SECURITY_REVIEW.md)

All items from the security review have been implemented.

---

## ✅ Implemented

### High

| ID  | Finding | Implementation |
|-----|---------|-----------------|
| **H1** | JWT algorithm restriction | `algorithms: ['HS256']` in `auth/jwt.ts` and `utils/jwt.ts` (already done previously). |
| **H2** | Password-reset tokens hashed | Migration `007_password_reset_token_hash.ts` adds `token_hash`; `routes/password-reset.ts` stores only hash (placeholder in `token`), lookup by `token_hash`; legacy rows migrated on use. |

### Medium

| ID  | Finding | Implementation |
|-----|---------|-----------------|
| **M1** | Contact: no PII in logs, validation, rate limit | `routes/contact.ts`: no PII in logs; `validateLength`/`validateEmail` for name, email, message (message cap 10k); `contactRateLimiter` (10/hour) in `security.ts`, applied in `index.ts`. |
| **M2** | CORS no-Origin | Comment in `index.ts` documenting that no-origin is intentional for non-browser clients. |
| **M3/L4** | Session secret required in production | `utils/env-validation.ts`: in production, `SESSION_SECRET` required and ≥32 chars (startup fails otherwise). `.env.example` updated. |
| **M4** | Redirect rate limit | `redirectRateLimiter` (200/15min) in `security.ts`; redirect route in `index.ts` uses it instead of `strictRateLimiter`. |
| **M5** | Error handler production messages | `middleware/error-handler.ts`: in production, fixed messages per status (400/401/403/404 → safe message; 500 → "Internal server error"); no `err.message` or stack in response. |

### Low

| ID  | Finding | Implementation |
|-----|---------|-----------------|
| **L1** | Tag ownership on bookmark create/update | `routes/bookmarks.ts`: for POST and PUT, each `tag_id` checked with `canAccessTag(userId, tagId)`; 403 if any tag not owned. |
| **L2** | Import cap | `routes/bookmarks.ts`: `importBookmarks.length > 1000` returns 400 with message "Import limited to 1000 bookmarks per request". |
| **L3** | Password-reset verify single message | `routes/password-reset.ts`: verify and reset use single message `"Invalid or expired token"` for invalid and expired cases. |

### Other (already in place)

- Centralized authorization (`auth/authorization.ts`) and GET bookmark list filter IDOR fix.
- Authorization tests in `backend/test/authorization.test.ts`.

---

## Files changed (this pass)

- `backend/src/db/migrations/007_password_reset_token_hash.ts` (new)
- `backend/src/db/migrations/index.ts` (register 007)
- `backend/src/routes/password-reset.ts` (hash-only storage, legacy migration, L3 message)
- `backend/src/routes/contact.ts` (M1: no PII logs, validation)
- `backend/src/routes/bookmarks.ts` (L1 tag ownership, L2 import cap)
- `backend/src/middleware/security.ts` (contactRateLimiter, redirectRateLimiter)
- `backend/src/middleware/error-handler.ts` (M5)
- `backend/src/utils/env-validation.ts` (M3/L4 SESSION_SECRET)
- `backend/src/utils/validation.ts` (MAX_LENGTHS.contactMessage)
- `backend/src/index.ts` (contactRateLimiter on contact, redirectRateLimiter on redirect, M2 comment)
- `.env.example` (SESSION_SECRET note)

---

## Verification

1. **H2:** Run migrations; request password reset; check DB has `token_hash` set and `token` is placeholder `h:<id>` for new rows. Verify and reset still work; legacy rows (pre-migration) work once and are migrated.
2. **M1:** Submit contact form; logs should show only "Form submitted". Send oversized name/email/message and expect 400. In production, >10 contact submissions per hour from one IP should hit rate limit.
3. **M3/L4:** Start backend with `NODE_ENV=production` and no `SESSION_SECRET`; startup should fail with validation error.
4. **M5:** In production mode, trigger a 400/404/500; response body should contain only the safe message, not stack or internal details.
5. **L1:** As user A, create/update bookmark with user B’s tag_id; expect 403.
6. **L2:** POST `/api/bookmarks/import` with 1001 items; expect 400.

Use the [Security Checklist](./SECURITY_REVIEW.md#security-checklist) in SECURITY_REVIEW.md for pre-release and recurring tasks.
