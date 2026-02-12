# Workload Identity Federation for GitHub Actions (no SA keys)

resource "google_iam_workload_identity_pool" "github" {
  project                   = local.project_id
  workload_identity_pool_id = "github-pool"
  display_name              = "GitHub Actions"
  description               = "Pool for GitHub Actions OIDC"
  disabled                  = false

  depends_on = [google_project_service.iam]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  project                            = local.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id  = "github-provider"
  display_name                       = "GitHub provider"
  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.actor"      = "assertion.actor"
    "attribute.repository" = "assertion.repository"
    "attribute.repository_owner" = "assertion.repository_owner"
  }
  attribute_condition = (
    var.github_repo != "" ? "assertion.repository == '${var.github_repo}'" :
    (var.github_org != "" ? "assertion.repository_owner == '${var.github_org}'" : "true")
  )
  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

# Allow GitHub Actions to impersonate the deployer SA (scoped by repo or org)
locals {
  wif_pool_id = google_iam_workload_identity_pool.github.name
}

resource "google_service_account_iam_member" "wif_github_deployer_repo" {
  count              = var.github_repo != "" ? 1 : 0
  service_account_id = google_service_account.deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${local.wif_pool_id}/attribute.repository/${var.github_repo}"
}

resource "google_service_account_iam_member" "wif_github_deployer_owner" {
  count              = var.github_repo == "" && var.github_org != "" ? 1 : 0
  service_account_id = google_service_account.deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${local.wif_pool_id}/attribute.repository_owner/${var.github_org}"
}

# When both empty: allow all identities in the pool (set github_repo or github_org for production)
resource "google_service_account_iam_member" "wif_github_deployer_pool" {
  count              = var.github_repo == "" && var.github_org == "" ? 1 : 0
  service_account_id = google_service_account.deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${local.wif_pool_id}"
}
