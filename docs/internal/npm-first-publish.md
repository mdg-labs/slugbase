# npm first publish — `@slugbase` CE packages

Operator-only steps for TASK-021. Automatable prep (package manifests) lands in the repo; **do not** run `npm publish` from CI until TASK-022 (trusted publishing) is configured.

## Prerequisites

- `@slugbase` npm organization exists with publish rights for your account
- Local Node ≥ 22.12 and pnpm (repo `packageManager` version)
- Packages prepared: `packages/shared-types` and `packages/ui` have `"private": false` and `publishConfig.access: "public"` (plan §3.2)

## First publish (once per package)

From the **slugbase** repo root:

```bash
npm login   # interactive; or export NPM_TOKEN with publish rights to @slugbase
```

Publish **`@slugbase/shared-types`** first (downstream packages depend on it):

```bash
cd packages/shared-types
pnpm build
npm publish --access public
```

Then **`@slugbase/ui`**:

```bash
cd ../ui
pnpm build
npm publish --access public
```

## Verify

```bash
npm view @slugbase/shared-types version
npm view @slugbase/ui version
```

Both should return the published semver (initially `0.0.0` unless bumped before publish).

## Next step — trusted publishing (TASK-022)

After at least one version of each package is on npmjs:

1. npmjs.com → package → **Settings → Trusted Publisher** → GitHub Actions
2. Owner: `mdg-labs`, repository: `slugbase`, workflow: `publish-npm.yml`, environment: `npm` (optional)
3. Land the OIDC publish workflow in slugbase (TASK-022) so subsequent releases do not need a long-lived `NPM_TOKEN`

See `docs/internal/open-core-refactor-plan.md` §3.2 and TASK-022 for the full bootstrap sequence.
