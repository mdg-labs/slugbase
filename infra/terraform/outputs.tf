output "cloud_run_url" {
  description = "Cloud Run service URL"
  value       = google_cloud_run_v2_service.backend.uri
}

output "artifact_registry_repository" {
  description = "Artifact Registry Docker repository (for image push)"
  value       = "${var.region}-docker.pkg.dev/${local.project_id}/${google_artifact_registry_repository.backend.repository_id}"
}

output "cloud_sql_connection_name" {
  description = "Cloud SQL instance connection name (project:region:instance)"
  value       = google_sql_database_instance.main.connection_name
}

output "runtime_service_account_email" {
  description = "Cloud Run runtime service account email"
  value       = google_service_account.runtime.email
}

output "deployer_service_account_email" {
  description = "GitHub Actions deployer service account email (used via WIF)"
  value       = google_service_account.deployer.email
}

output "workload_identity_provider" {
  description = "Workload Identity Federation provider resource name (set as WIF_PROVIDER in GitHub secrets)"
  value       = google_iam_workload_identity_pool_provider.github.name
}
