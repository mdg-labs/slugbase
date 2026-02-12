resource "google_artifact_registry_repository" "backend" {
  project       = local.project_id
  location      = var.region
  repository_id = var.artifact_registry_repo
  description   = "SlugBase backend container images"
  format        = "DOCKER"

  depends_on = [google_project_service.artifactregistry]
}
