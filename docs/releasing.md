# Releasing SlugBase

This document describes the versioning workflow and how to cut a release.

## Versioning

- **Format**: [Semantic Versioning](https://semver.org/) (MAJOR.MINOR.PATCH)
- **Source of truth**: Root `package.json` `version` field
- **Display**: `/api/version` returns `version` (semver), `commit` (Git SHA when built in CI), and `mode`

### Bump rules

| Type | When to use | Example |
|------|-------------|---------|
| **PATCH** | Bug fixes, security patches, small non-breaking changes | 1.0.0 → 1.0.1 |
| **MINOR** | New features, non-breaking changes | 1.0.1 → 1.1.0 |
| **MAJOR** | Breaking changes (API, config, migrations) | 1.1.0 → 2.0.0 |

## Release process

### 1. Prepare the release

1. Ensure all changes are merged to `main` (or the release branch)
2. Run tests: `npm run test --workspace=backend`
3. Run full build: `npm run build`

### 2. Bump version

Update the version in root `package.json`:

```bash
# Edit package.json and set "version": "1.2.3"
```

Optionally sync backend and frontend `package.json` versions for consistency (they are not used at runtime).

### 3. Update CHANGELOG

Edit `CHANGELOG.md`:

- Add a new `## [X.Y.Z] - YYYY-MM-DD` section
- List changes under Added, Changed, Deprecated, Removed, Fixed, Security
- Follow [Keep a Changelog](https://keepachangelog.com/) format

### 4. Commit and tag

```bash
git add package.json CHANGELOG.md
git commit -m "chore: release v1.2.3"
git tag v1.2.3
git push origin main
git push origin v1.2.3
```

### 5. GitHub Release (optional)

Create a release from the tag at **Releases** → **Draft a new release**:

- Tag: `v1.2.3`
- Title: `v1.2.3`
- Description: Copy the relevant section from CHANGELOG.md

## Deployment

| Trigger | Deploys to | Workflow |
|---------|------------|----------|
| Push tag `v*` (e.g. `v1.2.3`) | Fly.io production (slugbase-prod) | deploy-fly-prod |
| Push to `dev` or `staging` | Fly.io staging (slugbase-staging) | deploy-fly-staging |

Production only deploys on release tags—pushing to `main` does not trigger a deploy. Create and push a version tag to release.

Both workflows pass `COMMIT_SHA` to the Docker build so `/api/version` shows the deployed commit.

## Docker images

The `docker-build-push` workflow:

- **On tag push `v*`**: `v1.2.3`, `latest`
- **On push to `dev`**: `dev`, `dev-<sha>`
