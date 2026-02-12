resource "google_sql_database_instance" "main" {
  project             = local.project_id
  name                = "slugbase-db"
  region              = var.region
  database_version    = "POSTGRES_15"
  deletion_protection = false

  settings {
    tier              = var.cloud_sql_tier
    availability_type = "ZONAL"
    disk_size         = 10
    disk_type         = "PD_SSD"

    ip_configuration {
      ipv4_enabled = true
    }
  }

  depends_on = [
    google_project_service.sqladmin,
    google_project_service.servicenetworking,
  ]
}

resource "google_sql_database" "main" {
  project  = local.project_id
  name     = "slugbase"
  instance = google_sql_database_instance.main.name
}

resource "google_sql_user" "slugbase" {
  project  = local.project_id
  name     = "slugbase"
  instance = google_sql_database_instance.main.name
  password = random_password.db_password.result
}
