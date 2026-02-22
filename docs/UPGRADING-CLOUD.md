# Upgrading SlugBase Cloud to a new core version

SlugBase Cloud uses SlugBase core (this repo). **Core contains only self-hosted code and logic (multi-tenant ready).** All multi-tenant SaaS features, marketing (landing, pricing, contact, terms, privacy, imprint), and cloud-only infrastructure live in the **slugbase-cloud** repo.

When you release a new version of the core, upgrade the cloud deployment as follows.

## 1. Release core

- Bump version in root `package.json` (and in `packages/slugbase-core/package.json` if you publish from there).
- Tag and push, e.g. `git tag v1.2.0 && git push origin v1.2.0`.
- If you use the `release-publish.yml` workflow, the `slugbase-core` npm package is published on tag.

## 2. Update cloud to use the new core

SlugBase Cloud currently builds core from a checkout of this repo (see slugbase-cloud Dockerfile and deploy workflows). To upgrade:

1. **If using git checkout (current setup)**  
   Deploy from slugbase-cloud as usual. The deploy workflow checks out `mdg-labs/slugbase` at `HEAD` of the default branch. To pin a release, change the checkout step to use a ref (e.g. `ref: v1.2.0`) instead of the default branch.

2. **If using npm package (recommended)**  
   In slugbase-cloud, add or update `"@slugbase/core": "^1.2.0"` in `package.json`, run `npm update @slugbase/core`, then run tests and deploy. Cloud should depend on the published package and **not** copy core at build time; use `createApp`, `registerCoreRoutes`, and the frontend `App` with `basePath="/app"` and optional `apiBaseUrl` as documented in [PACKAGE-BOUNDARIES-AND-EXPORTS.md](PACKAGE-BOUNDARIES-AND-EXPORTS.md).

## 3. Test and deploy

- Run cloud tests (if any) and manual smoke tests.
- Deploy to staging first, then production.
- Watch for migration or config changes that might require env or schema updates.

## 4. Document the upgrade

- Note the new core version in your internal runbook or in slugbase-cloud’s release notes.
