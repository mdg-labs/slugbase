# SlugBase Documentation

This directory contains customer-facing documentation for SlugBase, organized by deployment type.

## Structure

- **`selfhosted/`** – Documentation for self-hosted SlugBase instances (setup, features, admin, OIDC, demo mode for self-hosted demo instances, etc.).
- **`cloud/`** – Documentation for SlugBase Cloud (hosted SaaS).
- **`assets/`** – Shared images and assets used by both selfhosted and cloud docs.

## Local-only: `internal/`

The **`internal/`** folder is for private notes and is **not tracked in git** and **not synced** to the public docs site. Use it for:

- Terraform and deployment runbooks
- Environment variable reference
- One-off operational notes

See the note in `.gitignore`: `docs/internal/` is excluded from version control.
