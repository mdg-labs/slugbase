# Runtime SA: used by Cloud Run. Least privilege: Cloud SQL + Secret Manager only.
resource "google_service_account" "runtime" {
  project      = local.project_id
  account_id   = "slugbase-run"
  display_name = "SlugBase Cloud Run runtime"
}

# Deployer SA: used by GitHub Actions via WIF. Push images + deploy Cloud Run.
resource "google_service_account" "deployer" {
  project      = local.project_id
  account_id   = "slugbase-deploy"
  display_name = "SlugBase GitHub Actions deployer"
}

# Runtime SA needs Cloud SQL Client and Secret Manager access
resource "google_project_iam_member" "runtime_cloudsql" {
  project = local.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_project_iam_member" "runtime_secret_accessor" {
  project = local.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.runtime.email}"
}

# Deployer SA: Run Admin, Artifact Registry writer, and ability to act as runtime SA
resource "google_project_iam_member" "deployer_run_admin" {
  project = local.project_id
  role    = "roles/run.admin"
  member  = "serviceAccount:${google_service_account.deployer.email}"
}

resource "google_project_iam_member" "deployer_artifact_registry" {
  project = local.project_id
  role    = "roles/artifactregistry.writer"
  member  = "serviceAccount:${google_service_account.deployer.email}"
}

# Deployer must be able to set the runtime SA on Cloud Run (actAs)
resource "google_service_account_iam_member" "deployer_act_as_runtime" {
  service_account_id = google_service_account.runtime.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.deployer.email}"
}
