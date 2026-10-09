# Landing page template

Template for the docs site's front page and, in a longer form, a
`concepts/product-overview` page. Voice rules are in
[style-guide.md](style-guide.md); paths, product facts and frontmatter are in
`.claude/customer-docs/docs-config.md`.

## Rules

| Rule | Detail |
| ---- | ------ |
| Claims | Every sentence traces to the spec's purpose and non-goals, or to behaviour you verified in the app. Cross-check each sentence before you propose it. |
| Deployment model | Only what `docs-config.md` § Product says. Never hint at, or compare with, an edition the product doesn't have. |
| Audience | `docs-config.md` § Product: who it is for, and the problem it removes for them. |
| Links | Only to pages that exist on the site, plus the source repository. Never link internal specs, roadmaps or checklists. Add links to guide or concept pages only once those pages exist. |
| Base path | Links carry the site base path when the framework needs it (`docs-config.md` § Frontmatter). |
| Not allowed | Tooling tag clouds, internal identifiers, env var names, pricing or roadmap promises, screenshots. |
| Language | English only. Short sentences. No hype. |

## Front page structure

```
---
<frontmatter per docs-config.md — the framework's landing/splash layout if it has one,
 with the product name, a one-sentence description, a one-sentence tagline, and two
 actions: "Get started" (primary) and "View the source" (secondary)>
---

## What <product> is
<what it connects or does, and how it runs — two or three sentences>

## How it works
<one picture in words: input → what the product does → outcome; then 3 numbered steps>

## Who it is for
<the audience sentence plus the problem it removes>

## What it is not
<the spec's non-goals, one bullet each, in customer words>

## Next steps
<links to Getting started and the source repository>
```

## What to source from the spec

| Section | Source |
| ------- | ------ |
| What it is | The spec's purpose section |
| How it works | The spec's purpose and domain-logic sections — the core loop in customer words |
| What it is not | The spec's non-goals, in customer words |
| Who it is for | `docs-config.md` § Product → Audience |

## Product overview page

Same four topics (what it is, what it is not, who it is for, how it works), as a standard concept page with the framework's normal frontmatter — no landing layout, no hero. Link onward to guide pages once they exist.
