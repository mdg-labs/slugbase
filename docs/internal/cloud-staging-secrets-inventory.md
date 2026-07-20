# Cloud staging — secrets inventory

**Captured:** 2026-06-21  
**Purpose:** Point-in-time inventory of Phase `Staging`, Fly `slugbase-staging-api`, and Cloudflare Workers secrets; what `sync-secrets` pushes today; what SlugBase Cloud actually needs.

> Values are **not** stored in this doc. Phase list output below shows `[REDACTED]` in AI-assisted terminals. Fly list shows digests only. Re-run the commands in §1–§3 to refresh.

---

## 1. Phase — `Staging` environment

**Command:**

```bash
phase secrets list --env Staging
```

**Output (2026-06-21):**

```
  🔮 Secrets for Application: SlugBase, Environment: Staging
  └── 📁 Path: / - 88 Secrets
      ┌─────────────────────────────────────────┬─────────────────────────────┐
      │ KEY                                     │ VALUE                       │
      ├─────────────────────────────────────────┼─────────────────────────────┤
      │ API_BASE_URL                            │ [REDACTED]                  │
      │ RATE_LIMIT_TOKEN_CREATION_MAX           │ [REDACTED]                  │
      │ APP_BASE_URL 💬                         │ [REDACTED]                  │
      │ CF_ACCESS_CLIENT_ID 💬                  │ [REDACTED]                  │
      │ CF_ACCESS_CLIENT_SECRET                 │ [REDACTED]                  │
      │ CHALLENGE_DEV_SKIP                      │ [REDACTED]                  │
      │ CLOUDFLARE_ACCOUNT_ID                   │ [REDACTED]                  │
      │ CLOUDFLARE_API_TOKEN 💬                 │ [REDACTED]                  │
      │ DATABASE_URL 💬                         │ [REDACTED]                  │
      │ DATABASE_URL_UNPOOLED                   │ [REDACTED]                  │
      │ DOWNGRADE_GRACE_PERIOD_DAYS             │ [REDACTED]                  │
      │ EMAIL_VERIFICATION_REQUIRED             │ [REDACTED]                  │
      │ ENCRYPTION_KEY                          │ [REDACTED]                  │
      │ FLY_API_TOKEN                           │ [REDACTED]                  │
      │ FRONTEND_ORIGIN                         │ [REDACTED]                  │
      │ MARKETING_ORIGIN                        │ [REDACTED]                  │
      │ MFA_TOTP_ISSUER                         │ [REDACTED]                  │
      │ OPENAI_API_KEY 💬                       │ [REDACTED]                  │
      │ OPENAI_MODEL                            │ [REDACTED]                  │
      │ OPENAPI_INTERACTIVE_DOCS 💬             │ [REDACTED]                  │
      │ PUBLIC_API_BASE_URL                     │ [REDACTED]                  │
      │ PUBLIC_CONTACT_ENDPOINT                 │ [REDACTED]                  │
      │ PUBLIC_FORWARDING_DOMAIN                │ [REDACTED]                  │
      │ PUBLIC_FREE_BOOKMARK_CAP                │ [REDACTED]                  │
      │ PUBLIC_FRONTEND_ORIGIN 💬               │ [REDACTED]                  │
      │ PUBLIC_REGISTRATION 💬                  │ [REDACTED]                  │
      │ PUBLIC_SUPPORTER_PROMOTION_END          │ [REDACTED]                  │
      │ PUBLIC_TEAM_BASE_SEATS                  │ [REDACTED]                  │
      │ PUBLIC_TOLGEE_API_URL                   │ [REDACTED]                  │
      │ PUBLIC_TURNSTILE_SITE_KEY               │ [REDACTED]                  │
      │ PUBLIC_UMAMI_HOST 💬                    │ [REDACTED]                  │
      │ PUBLIC_UMAMI_WEBSITE_ID                 │ [REDACTED]                  │
      │ RATE_LIMIT_EMAIL_VERIFICATION_MAX       │ [REDACTED]                  │
      │ RATE_LIMIT_EMAIL_VERIFICATION_TTL_SECON…│ [REDACTED]                  │
      │ RATE_LIMIT_LOGIN_MAX 💬                 │ [REDACTED]                  │
      │ RATE_LIMIT_LOGIN_TTL_SECONDS            │ [REDACTED]                  │
      │ RATE_LIMIT_TOKEN_CREATION_TTL_SECONDS   │ [REDACTED]                  │
      │ SENTRY_AUTH_TOKEN                       │ [REDACTED]                  │
      │ SENTRY_ENABLE_CONSOLE_LOGGING           │ [REDACTED]                  │
      │ SENTRY_ENVIRONMENT                      │ [REDACTED]                  │
      │ SENTRY_LOG_LEVEL                        │ [REDACTED]                  │
      │ SENTRY_ORG                              │ [REDACTED]                  │
      │ SENTRY_PROFILING_SAMPLE_RATE            │ [REDACTED]                  │
      │ SENTRY_PROJECT                          │ [REDACTED]                  │
      │ SENTRY_REPLAY_SAMPLE_RATE               │ [REDACTED]                  │
      │ SENTRY_TRACES_SAMPLE_RATE               │ [REDACTED]                  │
      │ SERVE_WEB_CLIENT                        │ [REDACTED]                  │
      │ SESSION_REMEMBER_TTL_DAYS               │ [REDACTED]                  │
      │ SESSION_SECRET 💬                       │ [REDACTED]                  │
      │ SESSION_TTL_DAYS 💬                     │ [REDACTED]                  │
      │ SMTP_FROM                               │ [REDACTED]                  │
      │ SMTP_HOST 💬                            │ [REDACTED]                  │
      │ SMTP_PASS                               │ [REDACTED]                  │
      │ SMTP_PORT                               │ [REDACTED]                  │
      │ SMTP_SECURE                             │ [REDACTED]                  │
      │ SMTP_USER                               │ [REDACTED]                  │
      │ STRIPE_PRICE_PERSONAL_ANNUAL            │ [REDACTED]                  │
      │ STRIPE_PRICE_PERSONAL_MONTHLY           │ [REDACTED]                  │
      │ STRIPE_PRICE_SUPPORTER                  │ [REDACTED]                  │
      │ STRIPE_PRICE_TEAM_ANNUAL                │ [REDACTED]                  │
      │ STRIPE_PRICE_TEAM_MONTHLY               │ [REDACTED]                  │
      │ STRIPE_SECRET_KEY 💬                    │ [REDACTED]                  │
      │ STRIPE_WEBHOOK_SECRET                   │ [REDACTED]                  │
      │ SUPPORTER_PROMOTION_END                 │ [REDACTED]                  │
      │ TURNSTILE_SECRET_KEY 💬                 │ [REDACTED]                  │
      │ UMAMI_HOST 💬                           │ [REDACTED]                  │
      │ UMAMI_WEBSITE_ID                        │ [REDACTED]                  │
      │ VITE_AI_BYO_CREDENTIAL                  │ [REDACTED]                  │
      │ VITE_API_URL                            │ [REDACTED]                  │
      │ VITE_APP_BASE_URL                       │ [REDACTED]                  │
      │ VITE_BILLING_ENABLED 💬                 │ [REDACTED]                  │
      │ VITE_FREE_BOOKMARK_CAP                  │ [REDACTED]                  │
      │ VITE_MAIL_ADMIN_UI 💬                   │ [REDACTED]                  │
      │ VITE_OIDC_ADMIN_UI                      │ [REDACTED]                  │
      │ VITE_SENTRY_DSN 💬                      │ [REDACTED]                  │
      │ VITE_SENTRY_PROJECT                     │ [REDACTED]                  │
      │ VITE_SUPPORTER_PROMOTION_END            │ [REDACTED]                  │
      │ VITE_TEAM_BASE_SEATS                    │ [REDACTED]                  │
      │ VITE_TOLGEE_API_URL                     │ [REDACTED]                  │
      │ VITE_UMAMI_HOST                         │ [REDACTED]                  │
      │ VITE_UMAMI_WEBSITE_ID                   │ [REDACTED]                  │
      │ FLY_ORG                                 │ [REDACTED]                  │
      │ SLUGBASE_EDITION                        │ [REDACTED]                  │
      │ SENTRY_DSN_API 💬                       │ [REDACTED]                  │
      │ NODE_ENV                                │ [REDACTED]                  │
      └─────────────────────────────────────────┴─────────────────────────────┘
🤖 AI mode: some values may be [REDACTED] based on secret type. To view, the user should run this command directly in their terminal.
🔬 To view a secret, use: phase secrets get <key>
🥽 To uncover the secrets, use: phase secrets list --show
```

**Count:** 88 keys.

---

## 2. Fly.io — `slugbase-staging-api`

**Command:**

```bash
flyctl secrets list --app slugbase-staging-api
```

**Output (2026-06-21):**

```
 NAME                                      │ DIGEST           │ STATUS   
 API_BASE_URL                              │ d5bdb909f11fbe17 │ Deployed 
 APP_BASE_URL                              │ d5bdb909f11fbe17 │ Deployed 
 CLOUDFLARE_ACCOUNT_ID                     │ 0f9083a8aa9aab7b │ Deployed 
 CLOUDFLARE_API_TOKEN                      │ 1916a22591fe435e │ Deployed 
 CONTACT_INBOX                             │ aa1b29221a0879a8 │ Deployed 
 DATABASE_URL                              │ 4966e4f7f825303d │ Deployed 
 DOWNGRADE_GRACE_PERIOD_DAYS               │ b4d64cb5995675a8 │ Deployed 
 EMAIL_VERIFICATION_REQUIRED               │ d8c5ac2e11c8e492 │ Deployed 
 ENCRYPTION_KEY                            │ de44babad7b0c73d │ Deployed 
 FLY_API_TOKEN                             │ ab6292c3f79cc431 │ Deployed 
 FLY_ORG                                   │ 9884075df6e3a0d3 │ Deployed 
 FRONTEND_ORIGIN                           │ cb107b8f27d7b7ce │ Deployed 
 MARKETING_ORIGIN                          │ 46dcf8ecdbcfd3de │ Deployed 
 MFA_TOTP_ISSUER                           │ b34c4a3bf873a132 │ Deployed 
 OPENAI_MODEL                              │ 1eeaa998148dae48 │ Deployed 
 OPENAPI_INTERACTIVE_DOCS                  │ d8c5ac2e11c8e492 │ Deployed 
 PUBLIC_CONTACT_ENDPOINT                   │ 0ee0cf7a27f4670e │ Deployed 
 PUBLIC_FREE_BOOKMARK_CAP                  │ 5662798d01feaa7f │ Deployed 
 PUBLIC_FRONTEND_ORIGIN                    │ cb107b8f27d7b7ce │ Deployed 
 PUBLIC_PLAN_PRICE_PERSONAL_MONTHLY        │ 0ab779622a75ac1d │ Deployed 
 PUBLIC_PLAN_PRICE_PERSONAL_YEARLY         │ 7899090b1edcb39c │ Deployed 
 PUBLIC_PLAN_PRICE_SUPPORTER               │ 7518df44d66d4026 │ Deployed 
 PUBLIC_PLAN_PRICE_TEAM_SEAT               │ 9bedc10e88eb936c │ Deployed 
 PUBLIC_PLAN_PRICE_TEAM_SEAT_YEARLY        │ 9bedc10e88eb936c │ Deployed 
 PUBLIC_REGISTRATION                       │ d8c5ac2e11c8e492 │ Deployed 
 PUBLIC_TEAM_BASE_SEATS                    │ 3baf154b33091aa0 │ Deployed 
 PUBLIC_TURNSTILE_SITE_KEY                 │ 4e64804a2f75b38e │ Deployed 
 RATE_LIMIT_CONTACT_MAX                    │ be7e1e7b58f32e7c │ Deployed 
 RATE_LIMIT_CONTACT_TTL_SECONDS            │ 79691544beb9dc25 │ Deployed 
 RATE_LIMIT_LOGIN_MAX                      │ 7a67330865a9a481 │ Deployed 
 RATE_LIMIT_LOGIN_TTL_SECONDS              │ b664a88e338af542 │ Deployed 
 RATE_LIMIT_TOKEN_CREATION_MAX             │ 0a4eb5a262c12e54 │ Deployed 
 RATE_LIMIT_TOKEN_CREATION_TTL_SECONDS     │ 79691544beb9dc25 │ Deployed 
 SERVE_WEB_CLIENT                          │ fa61a13817d73a23 │ Deployed 
 SESSION_SECRET                            │ 95667528da00affb │ Deployed 
 SESSION_TTL_DAYS                          │ b134196ffeb28941 │ Deployed 
 SMTP_FROM                                 │ 0448e0540c6c3cfd │ Deployed 
 SMTP_HOST                                 │ a7ee667ee376781e │ Deployed 
 SMTP_PASS                                 │ 503b03914cb948b1 │ Deployed 
 SMTP_PORT                                 │ 7e45a9e83c9d3eb8 │ Deployed 
 SMTP_SECURE                               │ fa61a13817d73a23 │ Deployed 
 SMTP_USER                                 │ 503b03914cb948b1 │ Deployed 
 TEAM_BASE_SEATS                           │ 3baf154b33091aa0 │ Deployed 
 TOLGEE_API_KEY                            │ 49bb8a67b557e235 │ Deployed 
 TOLGEE_PROJECT_ID                         │ 07e97d0e40ef95b6 │ Deployed 
 TURNSTILE_SECRET_KEY                      │ 87c3789c44c3bf19 │ Deployed 
 VITE_API_URL                              │ d5bdb909f11fbe17 │ Deployed 
 VITE_APP_BASE_URL                         │ d5bdb909f11fbe17 │ Deployed 
 VITE_TOLGEE_API_URL                       │ 0e44e48b8f05001b │ Deployed 
 DATABASE_URL_UNPOOLED                     │ 2012895ea6056748 │ Deployed 
 CF_ACCESS_CLIENT_ID                       │ 4d189eb7aaee2246 │ Deployed 
 CF_ACCESS_CLIENT_SECRET                   │ a82d85bbd4a057e2 │ Deployed 
 SENTRY_DSN                                │ 0b97e6639cb0463a │ Deployed 
 SENTRY_ENVIRONMENT                        │ 2915fc8b899d1812 │ Deployed 
 SENTRY_ORG                                │ 78bf31924239bb09 │ Deployed 
 VITE_SENTRY_DSN                           │ 7a2aec805a5b5f76 │ Deployed 
 SENTRY_AUTH_TOKEN                         │ 22692c0992ed6760 │ Deployed 
 RATE_LIMIT_EMAIL_VERIFICATION_MAX         │ f0247b96459e8044 │ Deployed 
 CHALLENGE_DEV_SKIP                        │ fa61a13817d73a23 │ Deployed 
 OPENAI_API_KEY                            │ 4c0aa095b539b701 │ Deployed 
 PUBLIC_FORWARDING_DOMAIN                  │ 49bb8a67b557e235 │ Deployed 
 PUBLIC_SUPPORTER_PROMOTION_END            │ a093de18ac4d28e0 │ Deployed 
 PUBLIC_TOLGEE_API_URL                     │ 0e44e48b8f05001b │ Deployed 
 PUBLIC_UMAMI_HOST                         │ 49bb8a67b557e235 │ Deployed 
 PUBLIC_UMAMI_WEBSITE_ID                   │ 49bb8a67b557e235 │ Deployed 
 RATE_LIMIT_EMAIL_VERIFICATION_TTL_SECONDS │ 79691544beb9dc25 │ Deployed 
 SENTRY_PROJECT                            │ 13fa8ad48aba736b │ Deployed 
 SENTRY_RELEASE                            │ 7785d92c4dc3ec9f │ Deployed 
 SESSION_REMEMBER_TTL_DAYS                 │ ed8dcf4bdd068705 │ Deployed 
 STRIPE_PRICE_PERSONAL                     │ 4c0aa095b539b701 │ Deployed 
 STRIPE_PRICE_SUPPORTER                    │ 7dbf124fbeba76cd │ Deployed 
 STRIPE_PRICE_TEAM                         │ e52f75346184900d │ Deployed 
 STRIPE_PRICE_TEAM_EXTRA_SEAT              │ 4c0aa095b539b701 │ Deployed 
 STRIPE_SECRET_KEY                         │ 46b02e4dc095466b │ Deployed 
 STRIPE_WEBHOOK_SECRET                     │ 2ba1df3252b1b6d9 │ Deployed 
 SUPPORTER_PROMOTION_END                   │ a093de18ac4d28e0 │ Deployed 
 UMAMI_HOST                                │ f1f51966b436e921 │ Deployed 
 UMAMI_WEBSITE_ID                          │ 4c0aa095b539b701 │ Deployed 
 VITE_AI_BYO_CREDENTIAL                    │ fa61a13817d73a23 │ Deployed 
 VITE_BILLING_ENABLED                      │ d8c5ac2e11c8e492 │ Deployed 
 VITE_FREE_BOOKMARK_CAP                    │ 5662798d01feaa7f │ Deployed 
 VITE_MAIL_ADMIN_UI                        │ fa61a13817d73a23 │ Deployed 
 VITE_OIDC_ADMIN_UI                        │ fa61a13817d73a23 │ Deployed 
 VITE_PLAN_PRICE_PERSONAL_MONTHLY          │ 0ab779622a75ac1d │ Deployed 
 VITE_PLAN_PRICE_PERSONAL_YEARLY           │ 7899090b1edcb39c │ Deployed 
 VITE_PLAN_PRICE_SUPPORTER                 │ 7518df44d66d4026 │ Deployed 
 VITE_PLAN_PRICE_TEAM_SEAT                 │ 9bedc10e88eb936c │ Deployed 
 VITE_SUPPORTER_PROMOTION_END              │ a093de18ac4d28e0 │ Deployed 
 VITE_TEAM_BASE_SEATS                      │ 3baf154b33091aa0 │ Deployed 
 VITE_UMAMI_HOST                           │ 49bb8a67b557e235 │ Deployed 
 VITE_UMAMI_WEBSITE_ID                     │ 49bb8a67b557e235 │ Deployed 
 WEB_CLIENT_SERVER_BUILD                   │ fa61a13817d73a23 │ Deployed 
 STRIPE_PRICE_PERSONAL_ANNUAL              │ 929dad2a216cede9 │ Deployed 
 STRIPE_PRICE_PERSONAL_MONTHLY             │ 6b790e08476f90e8 │ Deployed 
 STRIPE_PRICE_TEAM_ANNUAL                  │ 0ab9718df25dae7d │ Deployed 
 STRIPE_PRICE_TEAM_EXTRA_SEAT_ANNUAL       │ a2863dbae582cf71 │ Deployed 
 STRIPE_PRICE_TEAM_EXTRA_SEAT_MONTHLY      │ 925982270e17d6e0 │ Deployed 
 STRIPE_PRICE_TEAM_MONTHLY                 │ 69b31ea831cb8783 │ Deployed 
 PUBLIC_API_BASE_URL                       │ d5bdb909f11fbe17 │ Deployed 
 SENTRY_ENABLE_CONSOLE_LOGGING             │ d8c5ac2e11c8e492 │ Deployed 
 SENTRY_LOG_LEVEL                          │ e254966d5907613f │ Deployed 
 SENTRY_PROFILING_SAMPLE_RATE              │ ca15bcab176f2b6c │ Deployed 
 SENTRY_REPLAY_SAMPLE_RATE                 │ 566c22eee301b0a8 │ Deployed 
 SENTRY_TRACES_SAMPLE_RATE                 │ ca15bcab176f2b6c │ Deployed 
 VITE_SENTRY_PROJECT                       │ 10c0a4069e7dce45 │ Deployed
```

**Count:** 107 secret names (includes legacy keys not in current sync manifest).

**Not present on Fly at capture time:** `NODE_ENV`, `SLUGBASE_EDITION` (both required for API startup in production; set in Phase but not yet synced/deployed to Fly).

---

## 3. Cloudflare Workers — staging

### 3a. Web worker — `slugbase-staging-web`

**Command:**

```bash
npx wrangler@4 secret list --name slugbase-staging-web
```

**Output (2026-06-21):**

```
[
  {
    "name": "API_BASE_URL",
    "type": "secret_text"
  },
  {
    "name": "APP_BASE_URL",
    "type": "secret_text"
  },
  {
    "name": "CF_ACCESS_CLIENT_ID",
    "type": "secret_text"
  },
  {
    "name": "CF_ACCESS_CLIENT_SECRET",
    "type": "secret_text"
  },
  {
    "name": "CHALLENGE_DEV_SKIP",
    "type": "secret_text"
  },
  {
    "name": "CLOUDFLARE_ACCOUNT_ID",
    "type": "secret_text"
  },
  {
    "name": "CLOUDFLARE_API_TOKEN",
    "type": "secret_text"
  },
  {
    "name": "CONTACT_INBOX",
    "type": "secret_text"
  },
  {
    "name": "DATABASE_URL",
    "type": "secret_text"
  },
  {
    "name": "DATABASE_URL_UNPOOLED",
    "type": "secret_text"
  },
  {
    "name": "DOWNGRADE_GRACE_PERIOD_DAYS",
    "type": "secret_text"
  },
  {
    "name": "EMAIL_VERIFICATION_REQUIRED",
    "type": "secret_text"
  },
  {
    "name": "ENCRYPTION_KEY",
    "type": "secret_text"
  },
  {
    "name": "FLY_API_TOKEN",
    "type": "secret_text"
  },
  {
    "name": "FLY_ORG",
    "type": "secret_text"
  },
  {
    "name": "FRONTEND_ORIGIN",
    "type": "secret_text"
  },
  {
    "name": "MARKETING_ORIGIN",
    "type": "secret_text"
  },
  {
    "name": "MFA_TOTP_ISSUER",
    "type": "secret_text"
  },
  {
    "name": "OPENAI_API_KEY",
    "type": "secret_text"
  },
  {
    "name": "OPENAI_MODEL",
    "type": "secret_text"
  },
  {
    "name": "OPENAPI_INTERACTIVE_DOCS",
    "type": "secret_text"
  },
  {
    "name": "PUBLIC_API_BASE_URL",
    "type": "secret_text"
  },
  {
    "name": "PUBLIC_CONTACT_ENDPOINT",
    "type": "secret_text"
  },
  {
    "name": "PUBLIC_FORWARDING_DOMAIN",
    "type": "secret_text"
  },
  {
    "name": "PUBLIC_FREE_BOOKMARK_CAP",
    "type": "secret_text"
  },
  {
    "name": "PUBLIC_FRONTEND_ORIGIN",
    "type": "secret_text"
  },
  {
    "name": "PUBLIC_PLAN_PRICE_PERSONAL_MONTHLY",
    "type": "secret_text"
  },
  {
    "name": "PUBLIC_PLAN_PRICE_PERSONAL_YEARLY",
    "type": "secret_text"
  },
  {
    "name": "PUBLIC_PLAN_PRICE_SUPPORTER",
    "type": "secret_text"
  },
  {
    "name": "PUBLIC_PLAN_PRICE_TEAM_SEAT",
    "type": "secret_text"
  },
  {
    "name": "PUBLIC_PLAN_PRICE_TEAM_SEAT_YEARLY",
    "type": "secret_text"
  },
  {
    "name": "PUBLIC_REGISTRATION",
    "type": "secret_text"
  },
  {
    "name": "PUBLIC_SUPPORTER_PROMOTION_END",
    "type": "secret_text"
  },
  {
    "name": "PUBLIC_TEAM_BASE_SEATS",
    "type": "secret_text"
  },
  {
    "name": "PUBLIC_TOLGEE_API_URL",
    "type": "secret_text"
  },
  {
    "name": "PUBLIC_TURNSTILE_SITE_KEY",
    "type": "secret_text"
  },
  {
    "name": "PUBLIC_UMAMI_HOST",
    "type": "secret_text"
  },
  {
    "name": "PUBLIC_UMAMI_WEBSITE_ID",
    "type": "secret_text"
  },
  {
    "name": "RATE_LIMIT_CONTACT_MAX",
    "type": "secret_text"
  },
  {
    "name": "RATE_LIMIT_CONTACT_TTL_SECONDS",
    "type": "secret_text"
  },
  {
    "name": "RATE_LIMIT_EMAIL_VERIFICATION_MAX",
    "type": "secret_text"
  },
  {
    "name": "RATE_LIMIT_EMAIL_VERIFICATION_TTL_SECONDS",
    "type": "secret_text"
  },
  {
    "name": "RATE_LIMIT_LOGIN_MAX",
    "type": "secret_text"
  },
  {
    "name": "RATE_LIMIT_LOGIN_TTL_SECONDS",
    "type": "secret_text"
  },
  {
    "name": "RATE_LIMIT_TOKEN_CREATION_MAX",
    "type": "secret_text"
  },
  {
    "name": "RATE_LIMIT_TOKEN_CREATION_TTL_SECONDS",
    "type": "secret_text"
  },
  {
    "name": "SENTRY_AUTH_TOKEN",
    "type": "secret_text"
  },
  {
    "name": "SENTRY_DSN",
    "type": "secret_text"
  },
  {
    "name": "SENTRY_ENABLE_CONSOLE_LOGGING",
    "type": "secret_text"
  },
  {
    "name": "SENTRY_ENVIRONMENT",
    "type": "secret_text"
  },
  {
    "name": "SENTRY_LOG_LEVEL",
    "type": "secret_text"
  },
  {
    "name": "SENTRY_ORG",
    "type": "secret_text"
  },
  {
    "name": "SENTRY_PROFILING_SAMPLE_RATE",
    "type": "secret_text"
  },
  {
    "name": "SENTRY_PROJECT",
    "type": "secret_text"
  },
  {
    "name": "SENTRY_RELEASE",
    "type": "secret_text"
  },
  {
    "name": "SENTRY_REPLAY_SAMPLE_RATE",
    "type": "secret_text"
  },
  {
    "name": "SENTRY_TRACES_SAMPLE_RATE",
    "type": "secret_text"
  },
  {
    "name": "SERVE_WEB_CLIENT",
    "type": "secret_text"
  },
  {
    "name": "SESSION_REMEMBER_TTL_DAYS",
    "type": "secret_text"
  },
  {
    "name": "SESSION_SECRET",
    "type": "secret_text"
  },
  {
    "name": "SESSION_TTL_DAYS",
    "type": "secret_text"
  },
  {
    "name": "SMTP_FROM",
    "type": "secret_text"
  },
  {
    "name": "SMTP_HOST",
    "type": "secret_text"
  },
  {
    "name": "SMTP_PASS",
    "type": "secret_text"
  },
  {
    "name": "SMTP_PORT",
    "type": "secret_text"
  },
  {
    "name": "SMTP_SECURE",
    "type": "secret_text"
  },
  {
    "name": "SMTP_USER",
    "type": "secret_text"
  },
  {
    "name": "STRIPE_PRICE_PERSONAL",
    "type": "secret_text"
  },
  {
    "name": "STRIPE_PRICE_PERSONAL_ANNUAL",
    "type": "secret_text"
  },
  {
    "name": "STRIPE_PRICE_PERSONAL_MONTHLY",
    "type": "secret_text"
  },
  {
    "name": "STRIPE_PRICE_SUPPORTER",
    "type": "secret_text"
  },
  {
    "name": "STRIPE_PRICE_TEAM",
    "type": "secret_text"
  },
  {
    "name": "STRIPE_PRICE_TEAM_ANNUAL",
    "type": "secret_text"
  },
  {
    "name": "STRIPE_PRICE_TEAM_EXTRA_SEAT",
    "type": "secret_text"
  },
  {
    "name": "STRIPE_PRICE_TEAM_EXTRA_SEAT_ANNUAL",
    "type": "secret_text"
  },
  {
    "name": "STRIPE_PRICE_TEAM_EXTRA_SEAT_MONTHLY",
    "type": "secret_text"
  },
  {
    "name": "STRIPE_PRICE_TEAM_MONTHLY",
    "type": "secret_text"
  },
  {
    "name": "STRIPE_SECRET_KEY",
    "type": "secret_text"
  },
  {
    "name": "STRIPE_WEBHOOK_SECRET",
    "type": "secret_text"
  },
  {
    "name": "SUPPORTER_PROMOTION_END",
    "type": "secret_text"
  },
  {
    "name": "TEAM_BASE_SEATS",
    "type": "secret_text"
  },
  {
    "name": "TOLGEE_API_KEY",
    "type": "secret_text"
  },
  {
    "name": "TOLGEE_PROJECT_ID",
    "type": "secret_text"
  },
  {
    "name": "TURNSTILE_SECRET_KEY",
    "type": "secret_text"
  },
  {
    "name": "UMAMI_HOST",
    "type": "secret_text"
  },
  {
    "name": "UMAMI_WEBSITE_ID",
    "type": "secret_text"
  },
  {
    "name": "VITE_AI_BYO_CREDENTIAL",
    "type": "secret_text"
  },
  {
    "name": "VITE_API_URL",
    "type": "secret_text"
  },
  {
    "name": "VITE_APP_BASE_URL",
    "type": "secret_text"
  },
  {
    "name": "VITE_BILLING_ENABLED",
    "type": "secret_text"
  },
  {
    "name": "VITE_FREE_BOOKMARK_CAP",
    "type": "secret_text"
  },
  {
    "name": "VITE_MAIL_ADMIN_UI",
    "type": "secret_text"
  },
  {
    "name": "VITE_OIDC_ADMIN_UI",
    "type": "secret_text"
  },
  {
    "name": "VITE_PLAN_PRICE_PERSONAL_MONTHLY",
    "type": "secret_text"
  },
  {
    "name": "VITE_PLAN_PRICE_PERSONAL_YEARLY",
    "type": "secret_text"
  },
  {
    "name": "VITE_PLAN_PRICE_SUPPORTER",
    "type": "secret_text"
  },
  {
    "name": "VITE_PLAN_PRICE_TEAM_SEAT",
    "type": "secret_text"
  },
  {
    "name": "VITE_SENTRY_DSN",
    "type": "secret_text"
  },
  {
    "name": "VITE_SENTRY_PROJECT",
    "type": "secret_text"
  },
  {
    "name": "VITE_SUPPORTER_PROMOTION_END",
    "type": "secret_text"
  },
  {
    "name": "VITE_TEAM_BASE_SEATS",
    "type": "secret_text"
  },
  {
    "name": "VITE_TOLGEE_API_URL",
    "type": "secret_text"
  },
  {
    "name": "VITE_UMAMI_HOST",
    "type": "secret_text"
  },
  {
    "name": "VITE_UMAMI_WEBSITE_ID",
    "type": "secret_text"
  },
  {
    "name": "WEB_CLIENT_SERVER_BUILD",
    "type": "secret_text"
  }
]
```

**Count:** 107 secret bindings.

**Note:** `sync-secrets.sh` only pushes `API_BASE_URL` to this worker today. The other 106 bindings are legacy — likely copied from an earlier Fly-oriented sync or manual wrangler puts.

### 3b. Marketing worker — `slugbase-staging-marketing`

**Command:**

```bash
npx wrangler@4 secret list --name slugbase-staging-marketing
```

**Output (2026-06-21):**

```
[]
```

**Count:** 0 secret bindings (matches current sync manifest — marketing has no wrangler secrets).

---

## 4. Secret sync workflow — what it covers today

**Entry points**

| Trigger | Workflow | Script |
|---|---|---|
| Deploy pipeline (staging / production) | `.github/workflows/sync-secrets.yml` (called from `deploy.yml`) | `.github/scripts/sync-secrets.sh` |
| Manual | `sync-secrets.yml` `workflow_dispatch` | same |

**Flow:** Phase `Staging` / `Production` → GitHub Actions environment secrets (`staging` / `production`) → `sync-secrets.sh` → Fly API + Cloudflare Workers. No Phase CLI in CI.

**Platform tokens (GHA only — required to run sync, not pushed to app runtimes by design)**

- `FLY_API_TOKEN`
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

**Fly app** `slugbase-<env>-api` — keys pushed when non-empty in GHA env (`sync-secrets.sh` `API_FLY_KEYS`):

| Key | Notes |
|---|---|
| `NODE_ENV` | |
| `SLUGBASE_EDITION` | Must be `cloud` for Cloud |
| `SESSION_SECRET` | Required preflight |
| `ENCRYPTION_KEY` | Required preflight |
| `DATABASE_URL` | Required preflight |
| `APP_BASE_URL` | Required preflight |
| `FRONTEND_ORIGIN` | Required preflight |
| `MARKETING_ORIGIN` | |
| `PUBLIC_REGISTRATION` | |
| `EMAIL_VERIFICATION_REQUIRED` | |
| `SMTP_HOST` | |
| `SMTP_PORT` | |
| `SMTP_SECURE` | |
| `SMTP_USER` | |
| `SMTP_PASS` | |
| `SMTP_FROM` | |
| `OPENAI_API_KEY` | |
| `OPENAI_MODEL` | |
| `STRIPE_SECRET_KEY` | |
| `STRIPE_WEBHOOK_SECRET` | |
| `STRIPE_PRICE_PERSONAL_MONTHLY` | |
| `STRIPE_PRICE_PERSONAL_ANNUAL` | |
| `STRIPE_PRICE_TEAM_MONTHLY` | |
| `STRIPE_PRICE_TEAM_ANNUAL` | |
| `STRIPE_PRICE_SUPPORTER` | |
| `SUPPORTER_PROMOTION_END` | |
| `DOWNGRADE_GRACE_PERIOD_DAYS` | |
| `SESSION_TTL_DAYS` | |
| `SESSION_REMEMBER_TTL_DAYS` | |
| `MFA_TOTP_ISSUER` | |
| `RATE_LIMIT_LOGIN_MAX` | |
| `RATE_LIMIT_LOGIN_TTL_SECONDS` | |
| `RATE_LIMIT_TOKEN_CREATION_MAX` | |
| `RATE_LIMIT_TOKEN_CREATION_TTL_SECONDS` | |
| `RATE_LIMIT_EMAIL_VERIFICATION_MAX` | |
| `RATE_LIMIT_EMAIL_VERIFICATION_TTL_SECONDS` | |
| `TURNSTILE_SECRET_KEY` | |
| `CHALLENGE_DEV_SKIP` | |
| `UMAMI_HOST` | |
| `UMAMI_WEBSITE_ID` | |
| `SENTRY_DSN` | GHA storage key `SENTRY_DSN_API` → runtime `SENTRY_DSN` |
| `SENTRY_ENVIRONMENT` | |
| `SENTRY_TRACES_SAMPLE_RATE` | |
| `SENTRY_PROFILING_SAMPLE_RATE` | |
| `SENTRY_REPLAY_SAMPLE_RATE` | |
| `SENTRY_LOG_LEVEL` | |
| `SENTRY_ENABLE_CONSOLE_LOGGING` | |
| `OIDC_DEPLOYMENT_PROVIDERS` | Optional JSON array |

**Fly modes**

- Deploy chain: `FLY_SECRETS_MODE=stage-only` — secrets staged; deploy job applies image separately.
- `workflow_dispatch`: `stage-and-deploy` — stages then `flyctl secrets deploy`.

**Cloudflare Web worker** `slugbase-<env>-web` — wrangler secrets:

| Key |
|---|
| `API_BASE_URL` |

**Cloudflare Marketing worker** `slugbase-<env>-marketing` — no wrangler secrets synced today (empty list in manifest).

**Not synced by `sync-secrets.sh` (stay in GHA / Phase for CI and build only)**

- `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT` — API Sentry release + web Vite plugin source maps (`deploy.yml`, `sentry-release.sh`, `vite.config.ts`)
- `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` — staging smoke (`deploy.yml` smoke job)
- `API_BASE_URL` — also used by deploy-web / deploy-marketing build env (not only wrangler runtime)
- `DATABASE_URL` / `DATABASE_URL_UNPOOLED` — cloud migrate job in `deploy.yml` (GHA `staging` / `production` environments; reached via Pangolin tunnel on self-hosted runner)
- `PANGOLIN_ENDPOINT`, `PANGOLIN_MACHINE_ID`, `PANGOLIN_MACHINE_SECRET` — repo-level GHA secrets for Pangolin machine client (`scripts/ci/run-cloud-migrate.sh`); not in Phase
- All `VITE_*` / `PUBLIC_*` build keys in Phase — **not** in sync manifest; must be passed in deploy build steps if needed at build time

Canonical manifest: `scripts/sync-secrets-manifest.ts` (validated in CI by `scripts/validate-sync-secrets-manifest.ts`).

---

## 5. What SlugBase Cloud needs to run properly

### 5.1 Operator source of truth

1. **Phase** `Staging` / `Production` — operator edits keys.
2. Phase syncs to **GHA environment** `staging` / `production`.
3. **Deploy** runs migrations, builds, pushes secrets, deploys Fly + Workers.

### 5.2 API (Fly) — required to boot

| Key | Purpose |
|---|---|
| `SLUGBASE_EDITION` | `cloud` |
| `NODE_ENV` | `production` (also baked in `Dockerfile.api`; explicit sync recommended) |
| `SESSION_SECRET` | Session signing |
| `ENCRYPTION_KEY` | At-rest encryption |
| `DATABASE_URL` | Postgres |
| `APP_BASE_URL` | Public API URL |
| `FRONTEND_ORIGIN` | CORS / cookie origin for web app |

Edition presets (when `SLUGBASE_EDITION=cloud`) set defaults for `PUBLIC_REGISTRATION`, `EMAIL_VERIFICATION_REQUIRED`, `SERVE_WEB_CLIENT=false`, and web build flags — explicit `VITE_*` / `SERVE_WEB_CLIENT` in Phase should not conflict with presets.

### 5.3 API (Fly) — required for full Cloud product surface

| Area | Keys |
|---|---|
| Email | `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` |
| Billing | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PERSONAL_MONTHLY`, `STRIPE_PRICE_PERSONAL_ANNUAL`, `STRIPE_PRICE_TEAM_MONTHLY`, `STRIPE_PRICE_TEAM_ANNUAL`, `STRIPE_PRICE_SUPPORTER`, `SUPPORTER_PROMOTION_END`, `DOWNGRADE_GRACE_PERIOD_DAYS` |
| Bot protection | `TURNSTILE_SECRET_KEY` |
| AI suggestions | `OPENAI_API_KEY`, `OPENAI_MODEL` |
| Analytics (server) | `UMAMI_HOST`, `UMAMI_WEBSITE_ID` |
| Error reporting (API) | `SENTRY_DSN_API` in Phase → `SENTRY_DSN` on Fly |
| Cross-surface URLs | `MARKETING_ORIGIN` |
| Hosted OIDC (optional) | `OIDC_DEPLOYMENT_PROVIDERS` JSON — omit for DB/workspace-configured OIDC on CE-style flows; set for Cloud-hosted IdPs |

Session / rate-limit / MFA labels: `SESSION_TTL_DAYS`, `SESSION_REMEMBER_TTL_DAYS`, `MFA_TOTP_ISSUER`, `RATE_LIMIT_*`, `CHALLENGE_DEV_SKIP`, `SENTRY_ENVIRONMENT`, `SENTRY_*_SAMPLE_RATE`, `SENTRY_LOG_LEVEL`, `SENTRY_ENABLE_CONSOLE_LOGGING`.

### 5.4 Web worker (Cloudflare)

| Key | Where | Purpose |
|---|---|---|
| `API_BASE_URL` | Wrangler secret (synced) | SSR loaders / server actions |
| `FRONTEND_ORIGIN` | Phase → Fly API (CORS) | API trusts this origin |
| `SLUGBASE_EDITION=cloud` | Web **build** (`deploy-cf-worker.sh`) | Hardcoded in deploy script |
| `VITE_SENTRY_ENVIRONMENT` | Web build | Set from deploy environment name |
| `VITE_SENTRY_RELEASE` | Web build | From `deploy.yml` derive-sentry-release job |
| `VITE_SENTRY_DSN` | Web build (Phase / GHA) | Client Sentry — optional but recommended for Cloud |
| `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT` | Web build (CI) | Source map upload via Vite Sentry plugin |

### 5.5 Marketing worker (Cloudflare)

Build-time `PUBLIC_*` keys from Phase (e.g. `PUBLIC_FRONTEND_ORIGIN`, `PUBLIC_API_BASE_URL`, `PUBLIC_CONTACT_ENDPOINT`, `PUBLIC_TURNSTILE_SITE_KEY`, `PUBLIC_UMAMI_*`) — passed in `deploy-cf-worker.sh` when set in GHA env. Not synced via `sync-secrets.sh` today.

Smoke uses GHA **vars**: `APP_BASE_URL`, `FRONTEND_ORIGIN`, `MARKETING_ORIGIN`.

### 5.6 CI / deploy only (Phase Staging, not Fly runtime)

| Key | Purpose |
|---|---|
| `FLY_API_TOKEN` | `flyctl deploy` |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | `wrangler deploy` |
| `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` | Staging smoke through Cloudflare Access |
| `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT` | Sentry releases / source maps |
| `DATABASE_URL` / `DATABASE_URL_UNPOOLED` | `run-cloud-migrate.sh` in deploy pipeline (via Pangolin on self-hosted runner) |
| `PANGOLIN_ENDPOINT` / `PANGOLIN_MACHINE_ID` / `PANGOLIN_MACHINE_SECRET` | Pangolin machine client for cloud DB migrations (repo-level GHA secrets) |

### 5.7 URL wiring

Canonical hostnames for deploy plan probes and smoke are defined in [`scripts/ci/deploy-probe-origins.mjs`](../../scripts/ci/deploy-probe-origins.mjs). GHA environment `vars` / `secrets` override these when set.

| Surface | Key | Staging | Production |
|---|---|---|---|
| API | `APP_BASE_URL` | `https://staging-api.slugbase.app` | `https://api.slugbase.app` |
| Web | `FRONTEND_ORIGIN` | `https://staging-cloud.slugbase.app` | `https://cloud.slugbase.app` |
| Web SSR | `API_BASE_URL` | `https://staging-api.slugbase.app` | `https://api.slugbase.app` |
| Marketing | `MARKETING_ORIGIN` | `https://staging.slugbase.app` | `https://slugbase.app` |
| Admin | `ADMIN_URL` | `https://staging-admin.slugbase.app` | `https://admin.slugbase.app` |

See `docs/internal/environment-variables.md` for the full reference.

---

## 6. Refresh commands

```bash
# Phase
phase secrets list --env Staging

# Fly API
flyctl secrets list --app slugbase-staging-api

# Cloudflare (requires valid CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID)
npx wrangler@4 secret list --name slugbase-staging-web
npx wrangler@4 secret list --name slugbase-staging-marketing
```

After Phase edits: run **Sync secrets** workflow (`workflow_dispatch`, environment `staging`, `stage-and-deploy`) or push to `staging` to run the deploy pipeline sync job.
