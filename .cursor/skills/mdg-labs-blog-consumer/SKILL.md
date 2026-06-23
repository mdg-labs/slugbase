---
name: mdg-labs-blog-consumer
description: Set up and maintain @mdg-labs/blog on an Astro marketing site — install, content collection, routes, MDX, RSS, CI validation, and publish-first semver workflow. Use when adding blog to a site, wiring blog routes, writing posts, or bumping the package version.
---

# `@mdg-labs/blog` — consumer integration

Shared Astro blog infrastructure: content schema, MDX components, layouts, RSS/JSON-LD, and `blog-validate` CLI.

| | |
|---|---|
| **npm** | `@mdg-labs/blog` (public) |
| **Package repo** | `mdg-labs/blog` |
| **Spec** | `blog/docs/blog-system-plan.md` |

**Agents implement the package in `mdg-labs/blog`.** This skill covers **consumer wiring only**.

---

## Prerequisites

| Requirement | Detail |
|---|---|
| Site type | Astro marketing site with Content Collections |
| Astro | `^5` / `^6` / `^7` (peer) |
| @astrojs/mdx | Major aligned with Astro (`^7` for Astro 7) |
| Node | `>=22.12` for Astro 7 |
| Output | Static or prerendered blog routes |

Schema uses `astro/zod` inside the package — consumers do **not** need a separate `zod` dep for the blog collection.

---

## Install

```bash
npm install @mdg-labs/blog@^0.1.5 @astrojs/mdx
# or: pnpm add @mdg-labs/blog@^0.1.5 @astrojs/mdx
```

Example `package.json` deps (Astro 7):

```json
{
  "dependencies": {
    "@mdg-labs/blog": "^0.1.5",
    "@astrojs/mdx": "^7.0.0",
    "astro": "^7.0.0"
  },
  "engines": { "node": ">=22.12 <25" }
}
```

### Publish-first (agents)

1. Change lands in `mdg-labs/blog` → version bump → merge `main` → npm publish.
2. Then bump semver + lockfile in the consumer and run build.

Never commit `file:` paths. Never patch `node_modules`. If an export is missing, report `blocked: needs @mdg-labs/blog@X.Y.Z`.

---

## Integration checklist

### 1. Enable MDX

```js
// astro.config.mjs
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';

export default defineConfig({
  integrations: [mdx()],
});
```

### 2. Register the content collection

```ts
// src/content.config.ts (path varies — see table)
import { defineBlogCollection } from '@mdg-labs/blog';

const blog = defineBlogCollection({
  contentBase: './src/content/blog',
  locales: ['en', 'de'],
  defaultAuthor: 'MDG Labs', // optional
});

export const collections = { blog };
```

Merge with existing collections (`changelog`, `legal`, …) — one `collections` export.

| Consumer | Config path | `contentBase` | `locales` |
|---|---|---|---|
| **website** | `src/content.config.ts` | `./src/content/blog` | `['en', 'de']` |
| **slugbase** marketing | `packages/marketing/src/content.config.ts` | `./src/content/blog` | `['en', 'de']` |
| **pipewatch** marketing | `apps/marketing/src/content.config.ts` | `./content/blog` | `['en']` |

Snippet reference: `blog/packages/blog/templates/content.config.snippet.ts`

### 3. Copy route templates

Source templates: `blog/packages/blog/templates/pages/`

| Template | Destination (bilingual sites) |
|---|---|
| `blog-index.astro` | `src/pages/blog/index.astro` |
| `blog-post.astro` | `src/pages/blog/[slug].astro` |
| `blog-rss.xml.ts` | `src/pages/blog/rss.xml.ts` |
| `de/blog-index.astro` | `src/pages/de/blog/index.astro` |
| `de/blog-post.astro` | `src/pages/de/blog/[slug].astro` |

PipeWatch: copy the three non-`de/` templates only.

Adapt each file:

- Wrap `PostList` / `BlogPostLayout` in the site shell (`BaseLayout`, `MarketingLayout`, …)
- Pass `filterByLocale(..., 'en' | 'de')` on index and detail routes
- On server+prerender sites (PipeWatch): keep `export const prerender = true` on blog routes
- Set `site.name` / `site.url` in the RSS endpoint

### 4. Style MDX output

```astro
---
import '@mdg-labs/blog/styles/blog-prose.css';
// plus site token bridge, e.g. src/styles/blog.css
---
```

Render MDX with the package component map:

```astro
---
import { blogMdxComponents } from '@mdg-labs/blog';
const { Content } = await render(entry);
---
<Content components={blogMdxComponents} />
```

### 5. Write posts

Layout:

```
<contentBase>/
  en/welcome/index.mdx
  de/welcome/index.mdx
  my-post/index.mdx          # single-locale (PipeWatch)
```

URLs: `/blog/<slug>/`, `/de/blog/<slug>/` (bilingual), `/blog/rss.xml`.

Example fixture: `blog/packages/blog/fixtures/example-post/`

#### Frontmatter

| Field | Required | Notes |
|---|---|---|
| `title` | yes | max 120 |
| `description` | yes | max 300 |
| `pubDate` | yes | `YYYY-MM-DD` |
| `locale` | yes | `en` \| `de` |
| `updatedDate` | no | date |
| `slug` | no | kebab-case; defaults to folder name |
| `draft` | no | default `false`; excluded from index/RSS |
| `tags` | no | string[] |
| `author` | no | string |
| `heroImage` | no | relative path |
| `ogImage` | no | URL or path |
| `canonicalUrl` | no | URL |

Bilingual sites: use **matching folder names** under `en/` and `de/`; per-locale `slug` may differ.

### 6. Validate locally

```bash
# website / slugbase
npx blog-validate src/content/blog

# pipewatch
npx blog-validate content/blog

astro check   # if configured
astro build
```

### 7. CI

```yaml
- run: npm ci
- run: node --import tsx node_modules/@mdg-labs/blog/bin/blog-validate.ts src/content/blog
- run: npm run check
- run: npm run build
```

Adjust package manager and `contentBase` path per repo.

---

## Public API

| Export | Purpose |
|---|---|
| `defineBlogCollection(options)` | Register `blog` collection (glob loader + schema) |
| `blogPostSchema` | Frontmatter Zod schema |
| `blogMdxComponents` | MDX map: `Callout`, `CodeBlock` |
| `sortPostsByDate`, `filterByLocale`, `filterPublished`, `paginate` | Collection helpers |
| `resolvePostSlug(entry)` | Slug for `getStaticPaths` |
| `formatPostDate(date, locale)` | Display formatting |
| `buildRssFeed({ site, posts, locale? })` | RSS XML string |
| `buildBlogPostingJsonLd(post, site)` | JSON-LD `BlogPosting` |
| `validateBlogContent(contentBase, options?)` | Programmatic validation |
| `buildTranslationIndex`, `resolveBlogAlternateHref`, … | i18n / language switcher |
| `@mdg-labs/blog/layouts/BlogPostLayout.astro` | Post detail shell |
| `@mdg-labs/blog/layouts/PostList.astro` | Index list |
| `@mdg-labs/blog/layouts/PostCard.astro` | Card partial |
| `@mdg-labs/blog/styles/blog-prose.css` | Base prose styles |
| `blog-validate` (bin) | CLI — non-zero on schema/duplicate errors |

Package `exports` map: `blog/packages/blog/package.json`.

---

## Per-site notes

### website (MDG Labs roof)

Live reference implementation. Token bridge: `src/styles/blog.css`. CI: `src/content/blog`.

### slugbase marketing

Same URL pattern as website. Use `MarketingLayout` and marketing i18n — do not change legal page routes.

### pipewatch marketing

English only. `contentBase: './content/blog'`. Prerender all blog routes. RSS site URL: `https://pipewatch.app` (or staging). Changelog/legal unchanged.

---

## Smoke test

After wiring:

1. `blog-validate <contentBase>` exits 0
2. `astro build` succeeds
3. Index lists published posts; drafts hidden
4. Detail renders MDX + `Callout`
5. RSS contains `<item>` entries
6. Bilingual: language switcher resolves alternate href (when implemented)

---

## Updating the package version

1. Confirm target version exists on npm (`npm view @mdg-labs/blog version`).
2. Bump `"@mdg-labs/blog": "^X.Y.Z"` in consumer `package.json`.
3. Refresh lockfile; run validate + build.
4. Scan for breaking changes in `blog` release / README public API table.
