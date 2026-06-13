# SlugBase documentation

Documentation in this repository is split into two trees (spec §2.4, adapted for Documentation.AI publishing):

| Path | Audience | Synced to publish repo? |
|---|---|---|
| [`internal/`](internal/) | Engineering, product spec, design prototypes, env reference, legal drafts | **No** — stays in this repo only |
| [`public/`](public/) | Customer and operator guides (Documentation.AI MDX) | **Yes** — flat copy to [`mdg-labs/slugbase-docs`](https://github.com/mdg-labs/slugbase-docs) on `main` |

## Internal (`docs/internal/`)

Engineering source of truth for agents and contributors:

- [`slugbase-mvp-spec.md`](internal/slugbase-mvp-spec.md) — product spec
- [`engineering-decisions.md`](internal/engineering-decisions.md) — stack and conventions
- [`environment-variables.md`](internal/environment-variables.md) — configuration reference
- [`design-prototype/`](internal/design-prototype/) — V1/V2 UI prototypes
- [`slugbase-development-roadmap.md`](internal/slugbase-development-roadmap.md) — phased build plan

## Public (`docs/public/`)

Documentation.AI-compatible MDX, assets, and [`documentation.json`](public/documentation.json). Directory layout must match the **publish repo contract** in epic [#392](https://github.com/mdg-labs/slugbase/issues/392) — `docs/public/` paths map 1:1 to the `slugbase-docs` repo root after CI sync.

```
docs/public/              →  slugbase-docs/ (repo root)
├── documentation.json
├── selfhosted/
├── cloud/
├── assets/
└── scripts/
```

Public pages are populated in [#395](https://github.com/mdg-labs/slugbase/issues/395); this tree currently holds the scaffold only.
