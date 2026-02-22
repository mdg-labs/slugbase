# Publishing slugbase-core to npm

The core package is published as **@mdguggenbichler/slugbase-core** (package name: slugbase-core, under your npm username scope).

## One-time setup

1. **npm login**  
   Log in with your npm account (e.g. mdguggenbichler). You can publish to your own scope without creating an org.

   ```bash
   npm login
   ```

2. **Fix 403 "Two-factor authentication or granular access token..."**  
   npm requires either:

   - **Option A (recommended):** Enable 2FA on your npm account: [Account settings](https://www.npmjs.com/settings/~/account) → enable 2FA, then run `npm login` again and complete the OTP step when publishing.
   - **Option B:** Create a **granular access token** with:
     - Permission: **Publish packages**
     - Option: **Bypass 2FA** (if your org allows it)  
     [Create token](https://www.npmjs.com/settings/~/tokens) → use it as the password when you run `npm login`, or set `NPM_TOKEN` in the environment for CI.

## Publish from local

From the **repo root**:

```bash
npm run publish:core
```

This builds the repo, assembles the package (including `backend/dist`) in `.publish-core/`, and runs `npm publish --access public` for `@mdguggenbichler/slugbase-core`.

- **Dry run (build + pack only):** `npm run publish:core:dry-run`
- **Version:** Bump `version` in `packages/core/package.json` before publishing a new release.

## Consumers

- **Self-hosted app** (this repo): `apps/selfhosted` depends on `@mdguggenbichler/slugbase-core` (workspace or published).
- **slugbase-cloud:** Add `"@mdguggenbichler/slugbase-core": "0.0.1"` (or the range you need) in `package.json` and use the backend/frontend entrypoints as documented in PACKAGE-BOUNDARIES-AND-EXPORTS.md.
