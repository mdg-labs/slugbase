# Security audit informational follow-ups (SEC-017–SEC-027)

Disposition record for the SlugBase security audit informational items addressed in [#435](https://github.com/mdg-labs/slugbase/issues/435) (epic [#421](https://github.com/mdg-labs/slugbase/issues/421)).

| ID | Finding | Disposition | Notes |
|---|---|---|---|
| SEC-017 | In-memory rate limit store | **Defer** | NestJS `ThrottlerModule` uses the default in-process store. Per-instance counters do not share state across Fly.io replicas. Documented in `packages/backend/src/app.module.ts`. Distributed store (Redis) is a Fast-Follow when multi-instance rate limiting is required. |
| SEC-018 | Public OpenAPI `/docs` when enabled | **Fix** | Interactive Scalar UI at `GET /docs` is disabled in production (`NODE_ENV=production`): env parsing forces `OPENAPI_INTERACTIVE_DOCS=false` and the controller returns 404. `GET /openapi.json` remains available for tooling; it exposes the same contract surface as the public API. |
| SEC-019 | Non-prod AES decrypt returns `""` | **Fix** | `AesGcmCryptoService` strict decrypt mode applies when `isProduction` **or** `SENTRY_ENVIRONMENT=staging`, so staging misconfiguration fails fast instead of silently returning empty strings. Local dev/test retain lenient mode for fixture rotation. |
| SEC-020 | Verification/reset tokens in URL query | **Defer** | Email links use `?token=` query params (verify-email, reset-password, email-change). Moving to POST body or URL fragment requires email template, web route, and OIDC callback changes across packages. Accepted for v1 with short TTL + one-time use; revisit in a dedicated auth-hardening task. |
| SEC-025 | CSRF cookie readable by JS | **Accept** | Double-submit pattern (spec §5.8): `csrf_token` cookie is intentionally `httpOnly: false` so the SPA can mirror it in `X-CSRF-Token`. Session cookie remains `HttpOnly`. Mitigations: CSP from [#428](https://github.com/mdg-labs/slugbase/issues/428), `SameSite=Lax`, signed token. Documented in `packages/backend/src/auth/csrf/csrf.controller.ts`. |
| SEC-026 | Sentry Session Replay | **Fix** | Replay masks all text/inputs and blocks media. Session/error sampling is zero on auth and settings routes; navigation to those routes stops an active replay. See `packages/web/app/entry.client.tsx` and `packages/web/app/lib/sentry-replay-routes.ts`. |
| SEC-027 | Umami script from configurable host | **Fix** | Umami script URL origin must be HTTPS and appear in a build-time allowlist (`VITE_UMAMI_ALLOWED_ORIGINS` / `PUBLIC_UMAMI_ALLOWED_ORIGINS`). When the allowlist env is unset, only the configured host origin is permitted; when set, only listed origins load (configured host must be included explicitly). Implemented via `@slugbase/shared-types` `umami-host-allowlist` and wired in web + marketing loaders. |

## Related configuration

| Key | Purpose |
|---|---|
| `OPENAPI_INTERACTIVE_DOCS` | Enable Scalar UI at `/docs` (ignored in production) |
| `SENTRY_ENVIRONMENT` | When `staging`, enables strict AES decrypt (SEC-019) |
| `VITE_UMAMI_ALLOWED_ORIGINS` | Comma-separated HTTPS origins allowed for web Umami script |
| `PUBLIC_UMAMI_ALLOWED_ORIGINS` | Same for marketing site |

See [`environment-variables.md`](./environment-variables.md) for the full registry.
