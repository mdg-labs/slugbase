# GCP Terraform and Backend Deployment

This document covers the Terraform configuration for SlugBase backend on Google Cloud (Cloud Run, Cloud SQL, Secret Manager, Workload Identity Federation) and the GitHub Actions CI/CD workflow that deploys **only the backend**. The frontend is deployed separately (e.g. Cloudflare Pages).

**Constraint:** Google Cloud Workload Identity Federation (WIF) is used for all GitHub Actions authentication. No Service Account JSON keys are created or used.

---

## 1. Terraform usage

### Prerequisites

- [Terraform](https://www.terraform.io/downloads) >= 1.5
- [Google Cloud SDK](https://cloud.google.com/sdk/docs/install) (`gcloud`) authenticated with a user or service account that can create projects/resources
- Billing enabled on the GCP project
- If your organization enforces WIF, ensure you are not creating or using long-lived SA keys

### Required variables

Set these via `terraform.tfvars` (do not commit this file) or environment variables (`TF_VAR_*`):

| Variable       | Description |
|----------------|-------------|
| `project_id`   | GCP project ID |
| `region`       | GCP region (e.g. `us-central1`) for Cloud Run, Artifact Registry, Cloud SQL |
| `frontend_url` | Frontend URL (e.g. Cloudflare Pages) for CORS and redirects |
| `base_url`     | Backend base URL (e.g. Cloud Run service URL). You can set this after first deploy and re-apply. |

Copy the example and edit:

```bash
cp infra/terraform/terraform.tfvars.example infra/terraform/terraform.tfvars
# Edit infra/terraform/terraform.tfvars with your values
```

### Optional variables

- `slugbase_mode` – `selfhosted` (default) or `cloud`
- `github_repo` – Restrict WIF to this repo (e.g. `myorg/slugbase`). **Recommended for production.**
- `github_org` – Restrict WIF to this GitHub org (used only if `github_repo` is not set)
- `cloud_run_max_instances` – Max Cloud Run instances (default `5`)
- `cloud_run_concurrency` – Max concurrent requests per instance (default `80`)
- `cloud_sql_tier` – Cloud SQL tier (default `db-f1-micro`)

**CLOUD mode only** (when `slugbase_mode = "cloud"`). Set in `terraform.tfvars` as needed:

| Variable | Description |
|----------|-------------|
| `cookie_domain` | Cookie domain (e.g. `.slugbase.app`). Optional; can be derived from `base_url`. |
| `cors_extra_origins` | Extra CORS origins, comma-separated (e.g. `https://slugbase.app`). |
| `jwt_access_expires_in` | Access JWT expiry (e.g. `15m`). |
| `jwt_refresh_expires_days` | Refresh token validity in days (e.g. `7`). |
| `oidc_google_client_id` | Google OIDC client ID (non-secret). |
| `oidc_microsoft_client_id` | Microsoft OIDC client ID. |
| `oidc_microsoft_tenant` | Microsoft tenant (e.g. `common`). |
| `oidc_github_client_id` | GitHub OIDC client ID. |
| `smtp_enabled` | Set to `true` to enable SMTP from env in cloud mode. |
| `smtp_host`, `smtp_port`, `smtp_secure` | SMTP server settings. |
| `smtp_user`, `smtp_from`, `smtp_from_name` | SMTP identity (non-secret). |

OIDC client **secrets** and **SMTP password** are stored in Secret Manager (see below); add new secret versions with real values when using cloud mode.

### Commands

```bash
cd infra/terraform
terraform init
terraform plan
terraform apply
```

After apply, note the outputs (Cloud Run URL, Artifact Registry repo, WIF provider name, service account emails). You will need them for GitHub secrets and for `base_url`.

---

## 2. Workload Identity Federation (WIF)

GitHub Actions authenticates to GCP by exchanging a GitHub OIDC token for GCP credentials. No static keys are stored in GitHub.

### How it works

1. On workflow run, GitHub issues an OIDC token that includes claims such as `repository`, `ref`, `actor`.
2. Terraform creates a **Workload Identity Pool** and a **Workload Identity Provider** that trusts GitHub’s issuer (`https://token.actions.githubusercontent.com`).
3. The provider maps GitHub claims to pool attributes (e.g. `attribute.repository`, `attribute.repository_owner`).
4. An **attribute condition** (in the provider) and **IAM bindings** (on the deployer service account) restrict which workflows can impersonate the deployer SA.
5. The workflow uses `google-github-actions/auth` with `workload_identity_provider` and `service_account`; the action exchanges the OIDC token for a short-lived GCP access token for the deployer SA.

### IAM roles

- **Deployer SA** (used by GitHub via WIF): `roles/run.admin`, `roles/artifactregistry.writer`, and `roles/iam.serviceAccountUser` on the runtime SA. This allows pushing images and deploying Cloud Run.
- **Runtime SA** (used by Cloud Run): `roles/cloudsql.client`, `roles/secretmanager.secretAccessor`. No Artifact Registry access (Cloud Run uses deploy-time binding to pull the image).

### GitHub repository / environment mapping

- Set **`github_repo`** (e.g. `myorg/slugbase`) in Terraform so only that repository can assume the deployer SA. Optionally use a GitHub Environment (e.g. `production`) in the workflow for approval gates.
- The WIF provider’s attribute condition can further restrict by `assertion.repository` or `assertion.repository_owner`. The IAM binding uses `principalSet://.../attribute.repository/ORG/REPO`.

### GitHub secrets and variables

Configure in the repository (or organization):

| Name | Kind | Description |
|------|------|-------------|
| `WIF_PROVIDER` | Secret | Full WIF provider resource name (Terraform output `workload_identity_provider`) |
| `GCP_SERVICE_ACCOUNT` | Secret | Deployer service account email (Terraform output `deployer_service_account_email`) |
| `GCP_PROJECT_ID` | Secret or variable | GCP project ID |
| `GCP_REGION` | Secret or variable | GCP region (e.g. `us-central1`) |
| `ARTIFACT_REGISTRY_REPO` | Variable (optional) | Artifact Registry repo name (default `slugbase-backend`) |

---

## 3. Secrets: creation and rotation

Terraform creates Secret Manager **secrets** (and for DB + placeholders, the first **version**). Sensitive values are not stored in Terraform state except the generated DB password (stored in state and in Secret Manager).

### Secrets created by Terraform

| Secret ID | Purpose | Initial version |
|-----------|---------|-----------------|
| `slugbase-jwt-secret` | JWT signing | Placeholder; replace with real value (min 32 chars). |
| `slugbase-encryption-key` | Encryption for sensitive data | Placeholder; replace with real value (min 32 chars). |
| `slugbase-session-secret` | Session / OAuth flow | Placeholder; replace with real value (min 32 chars in production). |
| `slugbase-db-password` | PostgreSQL user password | Set by Terraform (do not rotate without updating Cloud SQL user). |
| `slugbase-oidc-google-client-secret` | Cloud mode: Google OIDC | Empty placeholder; add new version with real client secret when used. |
| `slugbase-oidc-microsoft-client-secret` | Cloud mode: Microsoft OIDC | Empty placeholder; add new version when used. |
| `slugbase-oidc-github-client-secret` | Cloud mode: GitHub OIDC | Empty placeholder; add new version when used. |
| `slugbase-smtp-password` | Cloud mode: SMTP password | Empty placeholder; add new version when using SMTP in cloud mode. |

### Setting initial values (JWT, encryption, session)

After first `terraform apply`, add or replace secret versions with real values:

```bash
# Generate and set JWT secret (min 32 chars)
echo -n "$(openssl rand -base64 48)" | gcloud secrets versions add slugbase-jwt-secret --data-file=-

# Generate and set encryption key (min 32 chars)
echo -n "$(openssl rand -hex 32)" | gcloud secrets versions add slugbase-encryption-key --data-file=-

# Session secret
echo -n "$(openssl rand -base64 48)" | gcloud secrets versions add slugbase-session-secret --data-file=-
```

Cloud Run uses `version: "latest"`, so new versions are picked up on the next revision (e.g. next deploy or “no-op” deploy).

### Cloud mode: OIDC and SMTP secrets

When running with `slugbase_mode = "cloud"`:

- **OIDC:** Set Terraform variables `oidc_*_client_id` (and `oidc_microsoft_tenant`). Then add secret versions for each provider you use:
  ```bash
  echo -n "YOUR_GOOGLE_CLIENT_SECRET"  | gcloud secrets versions add slugbase-oidc-google-client-secret --data-file=-
  echo -n "YOUR_MICROSOFT_CLIENT_SECRET" | gcloud secrets versions add slugbase-oidc-microsoft-client-secret --data-file=-
  echo -n "YOUR_GITHUB_CLIENT_SECRET"  | gcloud secrets versions add slugbase-oidc-github-client-secret --data-file=-
  ```
- **SMTP:** Set Terraform variables `smtp_enabled`, `smtp_host`, `smtp_port`, `smtp_secure`, `smtp_user`, `smtp_from`, `smtp_from_name`. Then set the SMTP password in Secret Manager:
  ```bash
  echo -n "YOUR_SMTP_PASSWORD" | gcloud secrets versions add slugbase-smtp-password --data-file=-
  ```
  Redeploy or wait for the next revision so Cloud Run uses the new version.

### Rotating secrets

1. **Add a new version** in Secret Manager (same secret ID, new payload). Cloud Run will use `latest` on the next revision.
2. Optionally **deploy a new revision** to force Cloud Run to re-read secrets: re-run the deploy workflow or run `gcloud run deploy slugbase-backend --image=... --region=...` with the same image.
3. **DB password rotation:** Create a new secret version for `slugbase-db-password`, update the Cloud SQL user password (e.g. via Cloud Console or `gcloud sql users set-password`), then deploy a new revision so Cloud Run picks up the new secret.

---

## 4. First deployment checklist

1. **Apply Terraform**
   - Set `project_id`, `region`, `frontend_url`; set `base_url` to a placeholder or update after first deploy.
   - Run `terraform init`, `terraform plan`, `terraform apply`.
   - Save outputs: `workload_identity_provider`, `deployer_service_account_email`, `cloud_run_url`, `artifact_registry_repository`, `cloud_sql_connection_name`, `runtime_service_account_email`.

2. **Set Secret Manager values**
   - Add real secret versions for JWT, encryption key, and session secret (see above). Leave DB password as Terraform-generated unless you rotate it.

3. **Configure GitHub**
   - Add secrets: `WIF_PROVIDER`, `GCP_SERVICE_ACCOUNT`, `GCP_PROJECT_ID`, `GCP_REGION`.
   - Optionally create a `production` environment and set protection rules.

4. **First deploy**
   - Push to `main` or run the “Deploy Backend to Cloud Run” workflow manually. The workflow builds the backend image, pushes to Artifact Registry, and deploys to Cloud Run.

5. **Update Terraform (optional)**
   - Set `base_url` in `terraform.tfvars` to the Cloud Run URL (or custom domain) and re-apply so the backend has the correct `BASE_URL` env var.

6. **Verify**
   - Open Cloud Run service URL; check `/api/health`. Complete setup in the app (create first user, etc.). Migrations run on backend startup.

---

## 5. Rollback

To roll back to a previous Cloud Run revision:

1. **List revisions**
   ```bash
   gcloud run revisions list --service=slugbase-backend --region=REGION --project=PROJECT_ID
   ```

2. **Route 100% traffic to a previous revision**
   ```bash
   gcloud run services update-traffic slugbase-backend \
     --to-revisions=REVISION_NAME=100 \
     --region=REGION --project=PROJECT_ID
   ```

   Or deploy an older image by tag (e.g. a previous commit SHA from Artifact Registry):
   ```bash
   gcloud run deploy slugbase-backend \
     --image=REGION-docker.pkg.dev/PROJECT_ID/slugbase-backend/COMMIT_SHA \
     --region=REGION --project=PROJECT_ID
   ```

3. Revert the application code if needed and push to trigger a new deploy, or keep traffic on the old revision until the next fix is ready.
