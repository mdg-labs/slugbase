# Documentation.AI publish verification

Operator smoke checklist for customer docs at [docs.slugbase.app](https://docs.slugbase.app).

## Publish chain

```text
mdg-labs/slugbase-docs (main)  →  Documentation.AI build  →  https://docs.slugbase.app
```

| Layer | Source of truth |
|---|---|
| Customer MDX | [`mdg-labs/slugbase-docs`](https://github.com/mdg-labs/slugbase-docs) repo root |
| Engineering docs | `mdg-labs/slugbase` → `docs/internal/` only |
| Local editing | [`slugbase.code-workspace`](../../slugbase.code-workspace) (both repos) |

**Publish:** push to `slugbase-docs` `main`. Documentation.AI rebuilds automatically.

**Do not** maintain a copy under `docs/public/` in the monorepo — that path was removed.

## Authoring notes

- **Web editor** — preferred for screenshots; uploads go to `blob-cdn.documentation.ai` and commit on `slugbase-docs`.
- **Code editor** — edit `.mdx` locally in `slugbase-docs`; push to `main` to publish.
- **Images** — use Documentation.AI `<Image>` with absolute CDN URLs from the web editor. Repo paths like `/assets/…` are **not** served on the live site.
- **Validation** — Documentation.AI build logs; no local `validate:docs-public` in the monorepo.

## Pre-flight (operator)

- [ ] Documentation.AI dashboard connected to `mdg-labs/slugbase-docs`, branch `main`
- [ ] Latest push to `main` triggered a successful build (zero MDX parse errors)

## Live site smoke

- [ ] `https://docs.slugbase.app/` loads (`initialRoute`: self-hosted introduction)
- [ ] Product switcher: **Self-hosted** and **Cloud**
- [ ] Sidebar groups match `documentation.json` for both products
- [ ] Sample internal links resolve (e.g. `/selfhosted/quick-start`, `/cloud/sign-up`)
- [ ] Uploaded screenshots render (CDN URLs, not broken `/assets/` paths)

## Optional regression

1. Trivial MDX edit in `slugbase-docs` → push `main`
2. Confirm Documentation.AI build succeeds
3. Confirm change visible on live site within build window

## Troubleshooting stale content and 500 errors

Documentation.AI hosts on Vercel ISR. After a large restructure you may see **both** symptoms:

| Symptom | Cause | Check |
|---------|-------|-------|
| Sidebar or copy looks like the **old** docs | `x-vercel-cache: STALE` — previous prerender still served | `curl -sI https://docs.slugbase.app/selfhosted/introduction \| rg vercel-cache` |
| **500** on renamed or new paths | Fresh prerender failed on MDX/runtime error | `curl -sI https://docs.slugbase.app/selfhosted/first-workspace-setup` |

Common MDX causes of 500 on fresh render:

- Unescaped placeholders such as `/go/<slug>` or `Bearer <token>` (use `&lt;slug&gt;` / `&lt;token&gt;`)
- `{/* screenshot:… */}` JSX comments (use `<Callout kind="info" title="Screenshot placeholder">`)
- `<Callout>` without a `title` attribute
- Raw `&` inside JSX attribute values (use `&amp;`)

After fixing MDX, push to `slugbase-docs` `main` and spot-check a mix of old paths, renamed paths, and new paths — all should return **200**, not STALE-only old content or 500.

## Related

- Customer docs README: [`slugbase-docs` repository](https://github.com/mdg-labs/slugbase-docs)
- MDX format rule: `slugbase-docs/.cursor/rules/documentation.ai.mdc`
- Authoring skill: `slugbase/.cursor/skills/write-customer-docs/SKILL.md` (monorepo)
- Parent epic: [#392](https://github.com/mdg-labs/slugbase/issues/392)
