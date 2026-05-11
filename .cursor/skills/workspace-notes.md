# Workspace notes (orchestrator / design rollout)

## Core → cloud pack

After changes that affect `@mdguggenbichler/slugbase-core`, bump `packages/core/package.json` version, point `slugbase-cloud` at `file:./vendor/mdguggenbichler-slugbase-core-<version>.tgz`, then `npm run pack:cloud` from slugbase with `SLUGBASE_CLOUD_ROOT` if needed, then `npm install` in cloud.

_last verified handoff: 0.1.66 — 2026-04-18_

## ESLint monorepo

`npm run lint --workspaces` runs eslint in each workspace that defines `lint`; root hoists eslint 9 + flat configs per package.

_added: 2026-04-18_
