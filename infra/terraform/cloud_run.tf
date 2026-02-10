# Cloud Run service for SlugBase backend.
# Initial image is a placeholder; GitHub Actions deploys the real image.

locals {
  cloud_sql_connection_name = google_sql_database_instance.main.connection_name
  # DB_HOST for pg client: Unix socket path (Cloud Run mounts at /cloudsql)
  db_host_socket = "/cloudsql/${local.cloud_sql_connection_name}"
}

resource "google_cloud_run_v2_service" "backend" {
  project  = local.project_id
  name     = var.cloud_run_service_name
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = google_service_account.runtime.email
    max_instance_request_concurrency = var.cloud_run_concurrency

    scaling {
      min_instance_count = 0
      max_instance_count = var.cloud_run_max_instances
    }

    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [local.cloud_sql_connection_name]
      }
    }

    containers {
      image = "us-docker.pkg.dev/cloudrun/container/hello"

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle          = true
      }

      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }

      # Non-secret env
      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "PORT"
        value = "8080"
      }
      env {
        name  = "DB_TYPE"
        value = "postgresql"
      }
      env {
        name  = "DB_HOST"
        value = local.db_host_socket
      }
      env {
        name  = "DB_PORT"
        value = "5432"
      }
      env {
        name  = "DB_NAME"
        value = google_sql_database.main.name
      }
      env {
        name  = "DB_USER"
        value = google_sql_user.slugbase.name
      }
      env {
        name  = "SLUGBASE_MODE"
        value = var.slugbase_mode
      }
      env {
        name  = "FRONTEND_URL"
        value = var.frontend_url
      }
      env {
        name  = "BASE_URL"
        value = var.base_url
      }

      # Secrets from Secret Manager (value_source)
      env {
        name = "JWT_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.jwt_secret.secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "ENCRYPTION_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.encryption_key.secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "SESSION_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.session_secret.secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "DB_PASSWORD"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.db_password.secret_id
            version = "latest"
          }
        }
      }
    }
  }

  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }

  depends_on = [
    google_project_service.run,
    google_secret_manager_secret_version.db_password,
    google_secret_manager_secret_version.jwt_secret,
    google_secret_manager_secret_version.encryption_key,
    google_secret_manager_secret_version.session_secret,
  ]
}
