# Cloud Run service for SlugBase backend.
# Initial image is a placeholder; GitHub Actions deploys the real image.

locals {
  cloud_sql_connection_name = google_sql_database_instance.main.connection_name
  # DB_HOST for pg client: Unix socket path (Cloud Run mounts at /cloudsql)
  db_host_socket = "/cloudsql/${local.cloud_sql_connection_name}"
  # Optional cloud-mode env (from variables; see variables.tf)
  cookie_domain             = var.cookie_domain
  cors_extra_origins        = var.cors_extra_origins
  jwt_access_expires_in     = var.jwt_access_expires_in
  jwt_refresh_expires_days  = var.jwt_refresh_expires_days
  oidc_google_client_id     = var.oidc_google_client_id
  oidc_microsoft_client_id  = var.oidc_microsoft_client_id
  oidc_microsoft_tenant     = var.oidc_microsoft_tenant
  oidc_github_client_id     = var.oidc_github_client_id
  smtp_enabled              = var.smtp_enabled
  smtp_host                 = var.smtp_host
  smtp_port                 = var.smtp_port
  smtp_secure               = var.smtp_secure
  smtp_user                 = var.smtp_user
  smtp_from                 = var.smtp_from
  smtp_from_name            = var.smtp_from_name
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

      # Optional cloud-mode env (non-secret). Empty string when not set.
      env {
        name  = "COOKIE_DOMAIN"
        value = local.cookie_domain
      }
      env {
        name  = "CORS_EXTRA_ORIGINS"
        value = local.cors_extra_origins
      }
      env {
        name  = "JWT_ACCESS_EXPIRES_IN"
        value = local.jwt_access_expires_in
      }
      env {
        name  = "JWT_REFRESH_EXPIRES_DAYS"
        value = local.jwt_refresh_expires_days
      }
      env {
        name  = "OIDC_GOOGLE_CLIENT_ID"
        value = local.oidc_google_client_id
      }
      env {
        name  = "OIDC_MICROSOFT_CLIENT_ID"
        value = local.oidc_microsoft_client_id
      }
      env {
        name  = "OIDC_MICROSOFT_TENANT"
        value = local.oidc_microsoft_tenant
      }
      env {
        name  = "OIDC_GITHUB_CLIENT_ID"
        value = local.oidc_github_client_id
      }
      env {
        name  = "SMTP_ENABLED"
        value = local.smtp_enabled
      }
      env {
        name  = "SMTP_HOST"
        value = local.smtp_host
      }
      env {
        name  = "SMTP_PORT"
        value = local.smtp_port
      }
      env {
        name  = "SMTP_SECURE"
        value = local.smtp_secure
      }
      env {
        name  = "SMTP_USER"
        value = local.smtp_user
      }
      env {
        name  = "SMTP_FROM"
        value = local.smtp_from
      }
      env {
        name  = "SMTP_FROM_NAME"
        value = local.smtp_from_name
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
      # OIDC client secrets (cloud mode). Add secret versions in Secret Manager if used.
      env {
        name = "OIDC_GOOGLE_CLIENT_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.oidc_google_client_secret.secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "OIDC_MICROSOFT_CLIENT_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.oidc_microsoft_client_secret.secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "OIDC_GITHUB_CLIENT_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.oidc_github_client_secret.secret_id
            version = "latest"
          }
        }
      }
      # SMTP password (cloud mode). Add secret version in Secret Manager if using SMTP in cloud.
      env {
        name = "SMTP_PASSWORD"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.smtp_password.secret_id
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

# -----------------------------------------------------------------------------
# Cloud-mode variables (also declared in variables.tf; duplicated here so the
# Terraform linter resolves references when only this file is analyzed).
# -----------------------------------------------------------------------------
variable "cookie_domain" {
  description = "Cookie domain for cloud mode (e.g. .slugbase.app)"
  type        = string
  default     = ""
}
variable "cors_extra_origins" {
  description = "Extra CORS origins for cloud mode, comma-separated"
  type        = string
  default     = ""
}
variable "jwt_access_expires_in" {
  description = "Cloud mode: access JWT expiry (e.g. 15m)"
  type        = string
  default     = ""
}
variable "jwt_refresh_expires_days" {
  description = "Cloud mode: refresh token validity in days (e.g. 7)"
  type        = string
  default     = ""
}
variable "oidc_google_client_id" {
  type    = string
  default = ""
}
variable "oidc_microsoft_client_id" {
  type    = string
  default = ""
}
variable "oidc_microsoft_tenant" {
  description = "Microsoft tenant (e.g. common)"
  type        = string
  default     = ""
}
variable "oidc_github_client_id" {
  type    = string
  default = ""
}
variable "smtp_enabled" {
  type    = string
  default = ""
}
variable "smtp_host" {
  type    = string
  default = ""
}
variable "smtp_port" {
  type    = string
  default = ""
}
variable "smtp_secure" {
  type    = string
  default = ""
}
variable "smtp_user" {
  type    = string
  default = ""
}
variable "smtp_from" {
  description = "From email address (e.g. noreply@example.com)"
  type        = string
  default     = ""
}
variable "smtp_from_name" {
  type    = string
  default = ""
}
