# Changelog

All notable changes to SlugBase will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-02-16

### Added

- Versioning workflow: CHANGELOG, `/api/version` semver, Fly deploy COMMIT_SHA, releasing docs
- `/api/version` now returns semantic version from package.json alongside commit SHA

### Fixed

- Health route Swagger JSDoc YAML parsing (descriptions with single quotes)
- Dependabot alert #6: qs package upgraded to 6.14.2 (GHSA-w7fw-mjwx-w883)
- Fly.io deploy now passes COMMIT_SHA to Docker build for version display

### Security

- qs: 6.14.1 → 6.14.2 (arrayLimit bypass in comma parsing, low severity)
