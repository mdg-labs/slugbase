# Changelog

All notable changes to SlugBase will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-05-11

### Added
- Initial stable public release of SlugBase as an open-source, self-hosted bookmark manager.
- Bookmark management with folders, tags, optional custom slugs, and optional link forwarding via `/go/:slug`.
- Sharing primitives for bookmarks and folders (teams/users where enabled).
- Import/export flows and internationalization support for multiple UI languages.
- Authentication stack with local email/password, OIDC provider support, optional MFA (TOTP + backup codes), and API tokens.
- Deployment support for SQLite (default) and PostgreSQL, plus Docker-based self-hosting flows.
- OpenAPI publishing (`/openapi.json`, `/openapi.yaml`) and Swagger UI (`/api-docs`) for API consumers.

### Changed
- Established a release/versioning workflow around `CHANGELOG.md`, semantic versions, `/api/version`, and deployment metadata.
- `/api/version` returns the semantic version from `package.json` together with commit SHA metadata.

### Fixed
- Health route Swagger JSDoc YAML parsing (descriptions with single quotes)
- Dependabot alert #6: qs package upgraded to 6.14.2 (GHSA-w7fw-mjwx-w883)
- Fly.io deploy now passes COMMIT_SHA to Docker build for version display

### Security
- qs: 6.14.1 → 6.14.2 (arrayLimit bypass in comma parsing, low severity)
