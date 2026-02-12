# Enable required GCP APIs for SlugBase backend

resource "google_project_service" "run" {
  project            = local.project_id
  service            = "run.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "artifactregistry" {
  project            = local.project_id
  service            = "artifactregistry.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "sqladmin" {
  project            = local.project_id
  service            = "sqladmin.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "secretmanager" {
  project            = local.project_id
  service            = "secretmanager.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "iam" {
  project            = local.project_id
  service            = "iam.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "servicenetworking" {
  project            = local.project_id
  service            = "servicenetworking.googleapis.com"
  disable_on_destroy = false
}
