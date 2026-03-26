# Upgrading SlugBase Cloud to a new core version

SlugBase Cloud depends on **`@mdguggenbichler/slugbase-core`**, shipped as a **vendored tarball** under `slugbase-cloud/vendor/` (built from [`packages/core`](../packages/core) in this repo). **Core** stays self-hosted product logic only; SaaS lives in **slugbase-cloud**.

## 1. Bump core version (optional but recommended)

Edit [`packages/core/package.json`](../packages/core/package.json) `version` so the packed filename changes (e.g. `0.1.0` → `0.1.1`).

## 2. Pack and copy into cloud

From **slugbase** repo root (sibling `slugbase-cloud`):

```bash
npm run pack:cloud
```

See [PUBLISHING-CORE.md](PUBLISHING-CORE.md) for `SLUGBASE_CLOUD_ROOT` if layouts differ.

## 3. Wire cloud to the new tarball

In **slugbase-cloud** `package.json`, set:

```json
"@mdguggenbichler/slugbase-core": "file:./vendor/mdguggenbichler-slugbase-core-0.1.1.tgz"
```

(use the actual filename `npm pack` produced). Then:

```bash
npm install
```

Commit `vendor/*.tgz`, `package.json`, and `package-lock.json`.

## 4. Integration surface

- **Backend:** `createApp`, `registerCoreRoutes`, `query`, `execute`, `requireAuth`, etc.
- **Frontend:** `import { App } from '@mdguggenbichler/slugbase-core/frontend'` with `basePath="/app"`.

See slugbase-cloud `docs/core-integration-contract.md` and [PACKAGE-BOUNDARIES-AND-EXPORTS.md](PACKAGE-BOUNDARIES-AND-EXPORTS.md).

## 5. Test and deploy

Build/test cloud, deploy (e.g. Fly). Docker expects `vendor/` present before `npm ci` (see slugbase-cloud `Dockerfile`).

## Optional: npm registry instead of vendor

You can publish manually from `.publish-core` and switch cloud to a semver; see [PUBLISHING-CORE.md](PUBLISHING-CORE.md). There is no automated publish workflow in this repo.
