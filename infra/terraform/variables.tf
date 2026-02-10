# Required variables for SlugBase backend on GCP

variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "region" {
  description = "GCP region for Cloud Run, Artifact Registry, and Cloud SQL"
  type        = string
}

variable "frontend_url" {
  description = "Frontend URL (e.g. Cloudflare Pages) for CORS and redirects"
  type        = string
}

variable "base_url" {
  description = "Backend base URL (e.g. Cloud Run service URL) for OIDC callbacks and API"
  type        = string
}

# Optional with defaults

variable "slugbase_mode" {
  description = "SlugBase mode: selfhosted or cloud"
  type        = string
  default     = "selfhosted"
}

variable "github_org" {
  description = "GitHub organization or owner for WIF principal restriction (e.g. myorg)"
  type        = string
  default     = ""
}

variable "github_repo" {
  description = "GitHub repository for WIF principal restriction (e.g. myorg/slugbase)"
  type        = string
  default     = ""
}

variable "cloud_run_max_instances" {
  description = "Maximum number of Cloud Run instances"
  type        = number
  default     = 5
}

variable "cloud_run_concurrency" {
  description = "Max concurrent requests per Cloud Run instance (default 80)"
  type        = number
  default     = 80
}

variable "cloud_run_service_name" {
  description = "Cloud Run service name"
  type        = string
  default     = "slugbase-backend"
}

variable "cloud_sql_tier" {
  description = "Cloud SQL instance tier (e.g. db-f1-micro, db-g1-small)"
  type        = string
  default     = "db-f1-micro"
}

variable "artifact_registry_repo" {
  description = "Artifact Registry Docker repository name"
  type        = string
  default     = "slugbase-backend"
}

# Cloud-mode variables (OIDC, SMTP, cookie, CORS, JWT) are declared in cloud_run.tf
# so the Terraform linter resolves them when analyzing that file. Set them in
# terraform.tfvars when slugbase_mode = "cloud".
