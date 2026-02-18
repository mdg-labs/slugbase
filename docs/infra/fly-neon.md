# SlugBase on Fly.io with Neon PostgreSQL

This document covers deploying SlugBase to Fly.io with Neon PostgreSQL. The deployment uses the **combined image** (frontend + backend) so a single Fly app serves the full stack. The setup supports staging (active) and production (ready when needed), both hosted in the EU (Frankfurt).

---

## Prerequisites

- [Fly.io CLI](https://fly.io/docs/hands-on/install-flyctl/) installed and authenticated (`fly auth login`)
- [Neon](https://neon.tech) account; create a project in **EU (Frankfurt)** for data residency
- GitHub repository with SlugBase code

---

## Branch-to-Environment Mapping

| Branch     | Fly App           | Triggers                 |
|-----------|-------------------|--------------------------|
| `dev`     | slugbase-staging  | Push, workflow_dispatch  |
| `staging` | slugbase-staging  | Push, workflow_dispatch  |
| `main`    | slugbase-prod     | Push, workflow_dispatch  |

Deployment is handled by GitHub Actions (`.github/workflows/deploy-fly-staging.yml` and `deploy-fly-prod.yml`). If you previously used Fly.io's built-in GitHub integration, disable it in the Fly dashboard (App → Deployments → Settings) to avoid duplicate deploys.

---

## 1. Create Neon Projects

1. Go to [Neon Console](https://console.neon.tech) and create a project.
2. Select region **EU (Frankfurt)** (`aws-eu-central-1`).
3. Copy the connection string from the **Connection details** panel (Node.js format).
4. For production later: create a second Neon project (or branch) and copy its connection string.

The connection string format: `postgresql://user:password@ep-xxx.eu-central-1.aws.neon.tech/neondb?sslmode=require`

---

## 2. Create Fly.io Apps

Create the staging app:

```bash
fly apps create slugbase-staging
```

Optionally create the production app (can be done later):

```bash
fly apps create slugbase-prod
```

---

## 3. Set Secrets

Non-sensitive vars are in `fly.toml`. Sensitive values must be set via `fly secrets set` **before the first deploy**.

### Required secrets

| Secret | Description |
|--------|-------------|
| `DATABASE_URL` | Neon PostgreSQL connection string: `postgresql://user:pass@host/db?sslmode=require` |
| `JWT_SECRET` | Min 32 chars. Generate: `openssl rand -hex 32` |
| `ENCRYPTION_KEY` | Min 32 chars. Generate: `openssl rand -hex 32` |
| `SESSION_SECRET` | Min 32 chars. Generate: `openssl rand -base64 48` |
| `FRONTEND_URL` | Full URL of the app (e.g. `https://slugbase-staging.fly.dev`) |
| `BASE_URL` | Full URL of the API (same as FRONTEND_URL for combined deploy) |

**Example (staging):**

```bash
fly secrets set \
  DATABASE_URL="postgresql://user:password@ep-xxx.eu-central-1.aws.neon.tech/neondb?sslmode=require" \
  JWT_SECRET="$(openssl rand -hex 32)" \
  ENCRYPTION_KEY="$(openssl rand -hex 32)" \
  SESSION_SECRET="$(openssl rand -base64 48)" \
  FRONTEND_URL="https://slugbase-staging.fly.dev" \
  BASE_URL="https://slugbase-staging.fly.dev" \
  -a slugbase-staging --org <your-org>
```

### Optional secrets (OIDC, SMTP, custom domain)

| Secret | Description |
|--------|-------------|
| `COOKIE_DOMAIN` | Cookie domain for shared auth (e.g. `.slugbase.app`) |
| `CORS_EXTRA_ORIGINS` | Extra CORS origins, comma-separated |
| `OIDC_GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `OIDC_GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `OIDC_MICROSOFT_CLIENT_ID` | Microsoft OAuth client ID |
| `OIDC_MICROSOFT_CLIENT_SECRET` | Microsoft OAuth client secret |
| `OIDC_GITHUB_CLIENT_ID` | GitHub OAuth client ID |
| `OIDC_GITHUB_CLIENT_SECRET` | GitHub OAuth client secret |
| `SMTP_ENABLED` | `true` or `false` |
| `SMTP_HOST` | SMTP server hostname |
| `SMTP_USER` | SMTP username |
| `SMTP_PASSWORD` | SMTP password |
| `SMTP_FROM` | From email address |
| `SMTP_FROM_NAME` | From display name |
| `AI_OPENAI_API_KEY` | OpenAI API key for AI bookmark suggestions (Personal/Team plans) |
| `AI_OPENAI_MODEL` | Model override (default: gpt-4o-mini) |

**Production** (when ready): repeat the required secrets with production values for `slugbase-prod`.

---

## 4. GitHub Setup

1. In GitHub: **Settings** → **Secrets and variables** → **Actions**
2. Add **`FLY_API_TOKEN`** (secret):
   - **For organizations:** run `fly tokens create org --org <your-org-slug>` (required to create apps)
   - **For personal account:** run `fly auth token`
   - Paste the token as the secret value
3. If using a **Fly.io organization**, add **`FLY_ORG`** as a **secret** (required):
   - **Settings** → **Secrets and variables** → **Actions** → **Secrets**
   - New secret: name `FLY_ORG`, value = your org slug (e.g. `my-company`)
   - Find your org slug: `fly orgs list` or in the Fly.io dashboard URL
   - Use a secret (not a variable) – org variables can be unavailable in some GitHub configs

4. **Optional – build-time secrets** (passed as Docker build args by the deploy workflows):
   - **`SENTRY_DSN_STAGING`** / **`SENTRY_DSN_PROD`** – Sentry DSN for error reporting (staging vs production)
   - **`FEATUREBASE_APP_ID`** – Featurebase Messenger (chat) widget app ID. Get it from Featurebase → Settings → Support → Customization → Install. If set, the widget is baked into the frontend at build time and appears on Cloud (staging/prod). For logged-in user identification you also set the Fly secret **`FEATUREBASE_JWT_SECRET`** (runtime).

---

## 5. First Deploy

**Staging** (from `dev` or `staging` branch):

```bash
git checkout dev
git push origin dev
```

This triggers `.github/workflows/deploy-fly-staging.yml`. Or trigger manually: **Actions** → **Deploy to Fly.io (Staging)** → **Run workflow**.

**Production** (from `main` branch):

```bash
git checkout main
git push origin main
```

This triggers `.github/workflows/deploy-fly-prod.yml`. Or trigger manually: **Actions** → **Deploy to Fly.io (Production)** → **Run workflow**. Ensure `slugbase-prod` secrets are configured (see step 3) before the first deploy.

---

## Troubleshooting

### Health check failures

- Ensure `/api/health` returns 200. The backend listens on port 8080.
- Increase `grace_period` in `fly.toml` if the app needs more startup time.

### DATABASE_URL format

- Include `?sslmode=require` for Neon.
- Ensure special characters in the password are URL-encoded in the connection string.
- If using individual vars instead of `DATABASE_URL`, set `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` (Neon provides these in the connection string breakdown).

### Cold start / scale-to-zero

- With `min_machines_running = 0`, the first request after idle may take a few seconds while a machine starts.
- Adjust `min_machines_running` in `fly.toml` if you need always-on instances.

---

## Related

- [Grafana + Stats setup](https://docs.slugbase.app/infra/grafana-stats) – monitoring and business metrics
- [GCP Terraform deployment](https://docs.slugbase.app/infra/terraform) – alternative deployment to Google Cloud
- [SlugBase documentation](https://docs.slugbase.app) – general configuration and setup
