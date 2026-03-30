# Packing core for SlugBase Cloud

SlugBase Cloud installs **`@mdguggenbichler/slugbase-core`** from a **`.tgz` in `slugbase-cloud/vendor/`** (see slugbase-cloud `vendor/README.md`). You do **not** need npmjs for that flow.

## One command (from slugbase repo root)

With **slugbase** and **slugbase-cloud** as sibling directories (`../slugbase-cloud`):

```bash
npm run pack:cloud
```

This runs `npm run build`, assembles `.publish-core/`, runs `npm pack`, and copies the tarball to `slugbase-cloud/vendor/`.

If your cloud repo lives elsewhere:

```bash
SLUGBASE_CLOUD_ROOT=../path/to/slugbase-cloud npm run pack:cloud
```

(`SLUGBASE_CLOUD_ROOT` can be absolute or relative to the slugbase root.)

Then in **slugbase-cloud**:

```bash
cd ../slugbase-cloud   # or your path
npm install
```

Update `package.json` → `file:./vendor/<name>.tgz` if the filename changed (version bump in `packages/core/package.json`), commit the new tarball and lockfile, deploy.

## Lower-level steps

- `npm run assemble:core` - build + assemble only (or `assemble:core:no-build` after you already built).
- Inspect `.publish-core/` before packing if needed.

## Optional: publish to npm

If you ever want a registry install instead of `vendor/*.tgz`, bump `packages/core/package.json`, run `npm run build` and `node scripts/assemble-core-package.js --no-build`, then `cd .publish-core && npm publish --access public` (requires `npm login`). There is **no** GitHub Action for this in this repo anymore.

## Consumers

- **Self-hosted** (this repo): `apps/selfhosted` uses the workspace `packages/core`.
- **slugbase-cloud:** `file:./vendor/*.tgz` or a published semver; see [UPGRADING-CLOUD.md](UPGRADING-CLOUD.md) and [PACKAGE-BOUNDARIES-AND-EXPORTS.md](PACKAGE-BOUNDARIES-AND-EXPORTS.md).
