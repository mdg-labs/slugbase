# SlugBase on Fly.io with Neon PostgreSQL

This document covers deploying SlugBase to Fly.io with Neon PostgreSQL. The deployment uses the **combined image** (frontend + backend) so a single Fly app serves the full stack. The setup supports staging (active) and production (ready when needed), both hosted in the EU (Frankfurt).

---

## Prerequisites

- [Fly.io CLI](https://fly.io/docs/hands-on/install-flyctl/) installed and authenticated (`fly auth login`)
- [Neon](https://neon.tech) account; create a project in **EU (Frankfurt)** for data residency
- GitHub repository with SlugBase code

---

## Branch-to-Environment Mapping

| Branch     | Fly App           | Triggers                    |
|-----------|-------------------|-----------------------------|
| `dev`     | slugbase-staging  | Push, workflow_dispatch    |
| `staging` | slugbase-staging  | Push, workflow_dispatch    |
| `main`    | slugbase-prod     | workflow_dispatch only*    |

\* Production auto-deploys on push to `main` are disabled by default. See [Enabling production](#enabling-production) when ready.

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

Secrets are configured per Fly app. Set them before the first deploy.

**Staging:**

```bash
fly secrets set \
  DATABASE_URL="postgresql://user:password@ep-xxx.eu-central-1.aws.neon.tech/neondb?sslmode=require" \
  JWT_SECRET="$(openssl rand -hex 32)" \
  ENCRYPTION_KEY="$(openssl rand -hex 32)" \
  SESSION_SECRET="$(openssl rand -base64 48)" \
  FRONTEND_URL="https://slugbase-staging.fly.dev" \
  BASE_URL="https://slugbase-staging.fly.dev" \
  DB_TYPE="postgresql" \
  NODE_ENV="production" \
  SLUGBASE_MODE="cloud" \
  -a slugbase-staging
```

**Cloud mode only** – add OIDC and SMTP if needed:

```bash
fly secrets set \
  COOKIE_DOMAIN=".yourdomain.com" \
  CORS_EXTRA_ORIGINS="https://yourdomain.com" \
  OIDC_GOOGLE_CLIENT_ID="..." \
  OIDC_GOOGLE_CLIENT_SECRET="..." \
  # ... other OIDC/SMTP vars \
  -a slugbase-staging
```

**Production** (when ready): repeat with production `DATABASE_URL`, `FRONTEND_URL`, `BASE_URL`, and other prod-specific values for `slugbase-prod`.

---

## 4. GitHub Setup

1. In GitHub: **Settings** → **Secrets and variables** → **Actions**
2. Add **`FLY_API_TOKEN`** (secret):
   - Run `fly auth token` (or `fly tokens create deploy` for deploy-only)
   - Paste the token as the secret value
3. If using a **Fly.io organization**, add **`FLY_ORG`** (variable):
   - **Settings** → **Secrets and variables** → **Actions** → **Variables**
   - New variable: name `FLY_ORG`, value = your org slug (e.g. `my-company`)
   - Find your org slug: `fly orgs list` or in the Fly.io dashboard URL

---

## 5. First Deploy

**Staging** (from `dev` or `staging` branch):

```bash
git checkout dev
git push origin dev
```

This triggers `.github/workflows/deploy-fly-staging.yml`. Or trigger manually: **Actions** → **Deploy to Fly.io (Staging)** → **Run workflow**.

**Production** (manual only until enabled):

- **Actions** → **Deploy to Fly.io (Production)** → **Run workflow**

---

## Enabling Production

When ready to deploy production on push to `main`:

1. Configure secrets for `slugbase-prod` (see step 3).
2. In `.github/workflows/deploy-fly-prod.yml`, remove the job-level `if`:

   ```yaml
   # Remove this line:
   if: github.event_name == 'workflow_dispatch'
   ```

3. Optionally add `environment: production` for approval gates.
4. Push to `main` to deploy.

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

- [GCP Terraform deployment](terraform.md) – alternative deployment to Google Cloud
- [SlugBase README](../../README.md) – general configuration and setup
