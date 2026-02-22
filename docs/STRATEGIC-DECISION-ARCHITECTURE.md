# Strategic Decision Analysis: SlugBase Architecture (3–5 Year Horizon)

This document analyzes three possible long-term architecture strategies for SlugBase. It is **not** a refactoring plan; it is a decision framework for choosing direction. The analysis is grounded in the [Current State Architecture Audit](#) and assumes growth of both self-hosted adoption and cloud SaaS.

---

## Option A — Keep Current Model (Build-Time Copy + Mode Switch)

**Model:** slugbase stays a standalone repo. slugbase-cloud copies slugbase at Docker build time (e.g. checkout into `./slugbase/`). Mode is controlled via env (`VITE_SLUGBASE_MODE`, `SLUGBASE_MODE`). Cloud logic is added via env, optional (unregistered) migrations, and future middleware/wrapper in slugbase-cloud.

### Pros

- **Minimal change.** No new packaging, no monorepo migration, no versioning story to invent. You keep the current mental model and CI.
- **Single source of truth.** One codebase; cloud is “same code, different build.” No drift between “core package” and “app” — they are the same thing.
- **Clear open-source story.** The public repo is “the app.” Contributors clone, build, run. No “which package do I change?” confusion.
- **Upgrade path is already documented.** UPGRADING-CLOUD describes pinning core by ref (e.g. `ref: v1.2.0`); you can move from `HEAD` to tagged releases without changing architecture.
- **Low abstraction.** No package boundaries to design or defend; mode is a build-time switch, not an API boundary.

### Cons

- **Cloud layer is still mostly aspirational.** Today slugbase-cloud has no tenant/org/billing implementation; the “extension” story (middleware, optional migrations) is design, not reality. You must build that layer without a formal extension API — it’s “wrap the app and set env.”
- **Upgrade is manual and brittle.** Cloud CI must checkout slugbase (branch or tag), then build. Pinning to a tag requires changing the workflow ref; any change to core’s build (paths, env, Dockerfile) can break cloud’s Dockerfile. You own the coupling.
- **Risk of env/mode creep.** As cloud features grow, the temptation to add `if (isCloud)` in core increases. SAAS-PREVENTION and cursor rules help, but the boundary is social and review-based, not structural.
- **Two repos to coordinate.** Every cloud-only behavior (tenant resolution, billing) must live in slugbase-cloud or behind strict guards in slugbase. Cross-repo changes (e.g. “core exposes a hook for cloud”) require two PRs, two releases, and a clear contract.

### Hidden Long-Term Risks

- **Accidental coupling.** Core already contains fly.toml, unregistered migrations 010–012/016–017, and `/app/*` links in landing. Without a structural boundary, more “cloud-only” artifacts can slip in (e.g. “small” Stripe checks “only when isCloud”). Over 3–5 years, the “pure core” narrative erodes unless you enforce the boundary with tooling and process.
- **Upgrade fatigue.** If cloud pins to a tag, you must bump the ref for every release. If cloud uses `HEAD`, you get accidental breakage when core changes. Either way, upgrades are manual and easy to defer — technical debt compounds.
- **No formal extension point.** “Middleware and optional migrations” is flexible but vague. New cloud requirements (e.g. rate limits per plan, webhooks) may require core changes (e.g. new hooks or config). You may end up with a de facto “cloud API” implemented ad hoc in core (guarded by `isCloud`) instead of in a dedicated layer.

### Protection Matrix (Option A)

| Criterion | Assessment |
|-----------|------------|
| **Open-source purity** | **Medium.** Purity depends on discipline and review. No structural barrier to leakage; fly.toml and unregistered migrations already in core. |
| **SaaS scalability** | **Medium.** Same code scales, but all new SaaS behavior must be either in cloud repo (no extension API yet) or behind `isCloud` in core. Can get messy as features grow. |
| **Upgrade safety** | **Low–Medium.** Manual, repo-coupled upgrades; pin-by-tag helps but is easy to forget or delay. |
| **Developer sanity** | **Medium.** Simple mental model (“one app, two builds”), but two repos and no clear “where does this go?” for edge cases. |

---

## Option B — Extract slugbase-core as NPM Package

**Model:** Extract backend and frontend into publishable packages (e.g. `@slugbase/core-backend`, `@slugbase/core-frontend`). slugbase (self-hosted) and slugbase-cloud (SaaS) become separate applications that depend on these packages. Both consume the same versioned core.

### Pros

- **Explicit versioning.** Cloud (and self-hosted) depend on `@slugbase/core-backend@1.2.0`. Upgrades are “bump dependency and test.” No git checkout in Docker; no ref to pin.
- **Clear API boundary.** What’s in the package is “core”; what’s in the app is “app.” Forces you to define what core exports (routes, middleware hooks, config shape). Reduces ad hoc `isCloud` branches if cloud uses the package as a library and composes.
- **Upgrade flow is standard.** `npm update @slugbase/core-backend`, run tests, deploy. CI can enforce “cloud must use core >= X” or “exact version.”
- **Open-source clarity.** The open-source offering can be “the self-hosted app” (slugbase repo) that uses `@slugbase/core-*`. Core packages can be published from the same repo (e.g. on tag). Contributors still work in one place if the app and packages live in one repo.

### Cons

- **Packaging and release overhead.** You must define what goes into each package, how frontend and backend packages are versioned (lockstep vs independent), and how to publish (CI on tag, manual). Build and publish pipelines get more complex.
- **Abstraction risk.** You might over-engineer “pluggable” APIs (hooks, events) that only cloud needs, or under-design and end up with a package that is “the whole app” with no real boundary — just a versioned tarball of the current monolith. Then you get the cost of packaging without the benefit of a clean extension point.
- **Dual consumption.** Self-hosted app and cloud app must both consume the package. If the package is “the full backend and frontend,” the “app” is thin (env and Docker). If the package is “library only,” you have to refactor core into library + app. That refactor is non-trivial.
- **Open-source perception.** If the “main” repo is just a thin wrapper around `@slugbase/core-*`, some contributors may feel the “real” code is “hidden” in packages. Mitigation: keep app + packages in one repo and publish packages from there so the repo is still the single source of truth.

### Hidden Long-Term Risks

- **Version lock-in and drift.** If cloud stays on an old major version of core (e.g. 1.x) while core moves to 2.x, you have to support multiple majors or force cloud to upgrade. If you version backend and frontend separately, you get matrix hell (backend 1.2 + frontend 1.1 vs 1.2).
- **Overengineering.** It’s easy to add “extension points” and “plugin APIs” that only one consumer (cloud) uses. That increases surface area and maintenance. The sweet spot is “core is a library with a clear, minimal API,” not “core is a framework.”
- **Publish and access.** Do you publish to npm public or private? If public, core is visible and usable by others (good for open source). If private, you need npm auth in CI and for contributors who might want to run the self-hosted app from source (they’d depend on the same package). Public packages for core keep the story simple.

### Protection Matrix (Option B)

| Criterion | Assessment |
|-----------|------------|
| **Open-source purity** | **High.** Core is literally a separate artifact; apps depend on it. Harder to accidentally mix SaaS into the published package if you treat the package as the “pure” surface. |
| **SaaS scalability** | **High.** Cloud app can depend on core and add its own routes, middleware, and services. Versioned upgrades reduce risk. |
| **Upgrade safety** | **High.** Semver and `npm update`; CI can gate on core version. |
| **Developer sanity** | **Medium–High.** Clear “core vs app” split, but packaging and versioning add cognitive load and process. |

---

## Option C — Monorepo with Strict Boundaries

**Model:** Single monorepo (e.g. `apps/selfhosted`, `apps/cloud`, `apps/docs`; `packages/core`, `packages/ui`, `packages/shared`). Core is in `packages/`; self-hosted and cloud are separate apps that depend on core. Docs are an app in the same repo.

### Pros

- **Architectural clarity in one place.** Everything is in one repo: core, self-hosted app, cloud app, docs. Boundaries are folder-based and can be enforced with tooling (e.g. “packages/core cannot import from apps/cloud”).
- **Atomic changes.** A change that touches core and cloud (e.g. new hook for tenant resolution) is one PR, one CI run. No cross-repo coordination.
- **Future scalability.** Easy to add more apps (e.g. mobile, CLI) or more packages (e.g. shared types, config schema). Build and test can be incremental (only affected apps/packages).
- **SaaS isolation by structure.** If `apps/cloud` is the only place that imports billing or Stripe, and `packages/core` has no such dependency, leakage is visible in the dependency graph. Tools (e.g. dependency-cruiser, ESLint) can enforce “core does not import cloud.”

### Cons

- **Open-source perception and licensing.** One repo containing both “open core” and “private SaaS” is problematic: you can’t open-source the whole repo. So you must either (1) keep cloud in a separate private repo and only open-source part of the monorepo (which is then “multiple repos” again), or (2) have a monorepo that is entirely private and publish “core” as extracted packages — which is Option B with a monorepo layout. So “one monorepo for everything” conflicts with “core is open, cloud is private.”
- **CI complexity.** Monorepo CI must build/test the right subset, handle publish from packages, and possibly support different visibility (public vs private). You need a strategy for which parts are public and how they’re published.
- **Contributor friendliness.** If the open-source repo is a monorepo with `apps/selfhosted` and `packages/core` but no `apps/cloud` (private elsewhere), contributors see a clear split. If the repo is private and you “open” only packages via npm, contributors don’t get “one repo to clone” — they get “npm install the package.” So the “monorepo” that includes cloud is almost certainly private, and the “open” surface is either a separate repo (current slugbase) or published packages. That reduces the “one repo” benefit for open source.

### Hidden Long-Term Risks

- **Boundary creep.** Without strict tooling, imports can creep (e.g. cloud imports from core, then core starts importing from a “shared” module that cloud also uses for billing). You need dependency rules and possibly a custom lint or dependency-cruiser config.
- **Monorepo tooling.** You’ll want a standard (npm workspaces, pnpm, Turborepo, Nx) for tasks and caching. That’s more setup and maintenance. If the “monorepo” is really “slugbase repo + slugbase-cloud repo” with core as a package published from slugbase, you’re in Option B territory with a nicer folder structure.
- **Open-source story.** The only way to keep “clone one repo and run the self-hosted app” is to have the open repo be either (1) the current slugbase (standalone app + optional packages) or (2) a monorepo that contains only public code (e.g. apps/selfhosted, packages/core, apps/docs) with cloud in another repo. So Option C, in practice, often collapses to “monorepo for open stuff only” and “cloud in a second repo” — which is Option A or B with a monorepo layout for the open part.

### Protection Matrix (Option C)

| Criterion | Assessment |
|-----------|------------|
| **Open-source purity** | **High if** core and self-hosted are in a public monorepo and cloud is elsewhere; **low if** everything is in one private monorepo (no single “open” clone). |
| **SaaS scalability** | **High.** Clear app boundaries; core is a dependency. Same as Option B if core is a package. |
| **Upgrade safety** | **High.** Same as Option B if core is versioned and consumed as dependency. |
| **Developer sanity** | **Medium.** One repo is nice; tooling and visibility (what’s public vs private) add complexity. |

---

## Summary Comparison

| Criterion | Option A (Current) | Option B (NPM Package) | Option C (Monorepo) |
|-----------|---------------------|-------------------------|----------------------|
| Open-source purity | Medium (discipline-based) | High (artifact boundary) | High only if core/selfhosted public, cloud separate |
| SaaS scalability | Medium | High | High |
| Upgrade safety | Low–Medium | High | High |
| Developer sanity | Medium | Medium–High | Medium |
| Implementation cost | None | Medium (packaging, publish) | High (restructure + tooling) |
| Risk of leakage | Higher (social boundary) | Lower (package boundary) | Lower if enforced by structure |

---

## Recommendation: **Option B (Extract slugbase-core as NPM Package)**

**Direction:** Extract core into versioned packages consumed by both the self-hosted app and slugbase-cloud. Keep the current slugbase repo as the home of core packages and the self-hosted app; slugbase-cloud becomes an app that depends on those packages (and can remain a separate repo).

### Why Option B

1. **Protects open-source purity.** The “core” is a published artifact with a clear surface. Whatever is not in the package is not core. That makes it harder for SaaS logic to creep in, because the boundary is technical (what’s in the package and what it exports), not just review and cursor rules. You can still keep one repo: slugbase repo contains `packages/core-backend`, `packages/core-frontend`, and the self-hosted app that uses them; publish on tag. Open-source contributors work in that repo; they don’t need to touch slugbase-cloud.

2. **SaaS scalability with upgrade safety.** slugbase-cloud does `npm install @slugbase/core-backend@^1.2.0`, builds its own Docker image with its own middleware and routes, and deploys. Upgrades are “bump version, test, deploy.” No git checkout in Docker, no ref pinning. You get a real extension model: cloud is an app that composes core and adds tenant/org/billing. Over 3–5 years, that scales better than “copy the same repo and set env.”

3. **Avoids Option A’s long-term traps.** Option A is simple today but relies on discipline. You already have fly.toml and unregistered migrations in core. Without a structural boundary, in 3–5 years you risk either a core full of `isCloud` branches or a cloud layer that can’t cleanly extend core. Option B forces a clear “core API” and keeps cloud out of the core artifact.

4. **Option C doesn’t solve the private/public split.** You cannot have one monorepo that is both fully open and contains private cloud code. So “monorepo” either means (a) public monorepo (core + self-hosted + docs) and cloud in another repo, or (b) private monorepo and you publish core as packages. (a) is Option B with a monorepo layout inside the open repo. (b) loses “clone one repo” for open source. So the real choice is A vs B; C is a layout choice that fits with B.

### Why not Option A

Sticking with “build-time copy + mode switch” is the path of least resistance now but the path of most resistance in 3–5 years. Upgrade story stays manual; the boundary between core and cloud stays social. You’ve already seen leakage (fly.toml, unregistered migrations, `/app/*` in core). Option A accepts that and doubles down on process. Process is good, but a technical boundary (the package) is more reliable.

### Why not Option C as “the” strategy

Monorepo is a structure, not a substitute for the dependency model. The decisive choice is “core as a versioned dependency” (B) vs “core as a copied tree” (A). Monorepo can support B (e.g. slugbase repo = monorepo with packages/core and app selfhosted; cloud repo uses the published package). So: **choose B; adopt a monorepo layout inside slugbase only if it clearly improves local dev and CI**, not as a requirement for the strategy.

### How to think about the next steps (no refactor yet)

- **Decide** that the long-term direction is Option B: core becomes a consumable package (or packages), self-hosted and cloud both consume it.
- **Keep** Option A for the short term: no big-bang refactor. Use the current copy-at-build-time and env-based mode while you design the package surface (what does core export? what’s the minimal “app” that uses it?).
- **Tighten** Option A in the meantime: move fly.toml to slugbase-cloud, resolve `/app/*` vs self-hosted routes, and document that unregistered migrations 010–017 are out of scope for core. That reduces leakage and makes a future extraction (B) cleaner.
- **When** you implement B: extract core into packages in the slugbase repo, make the self-hosted app depend on them, publish on tag, then change slugbase-cloud to depend on the package and remove the git checkout from its Dockerfile. That’s a bounded, sequential change set.

---

*This document is a strategic decision record. It does not prescribe implementation steps; those should be derived from this direction and the Current State Architecture Audit.*
