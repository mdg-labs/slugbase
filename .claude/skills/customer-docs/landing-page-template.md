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
| Link form | Relative file paths between pages, or `/docs/...` routes (`docs-config.md` § Frontmatter); the source repository by its full `https://` address. |
| Not allowed | Tooling tag clouds, internal identifiers, env var names, pricing or roadmap promises, screenshots, raw HTML. |
| Language | English only. Short sentences. No hype. |

## Front page structure

The page goes at the landing path of `docs-config.md` § Customer doc layout (the content root's `index.md`). Fill every placeholder and delete none of the sections.

```markdown
---
title: "{PRODUCT_NAME}"
description: "{ONE_LINE — the tagline}"
edition: both
order: 0
---

{ONE_SENTENCE — the product in customer words.}

## What {PRODUCT_NAME} is

{What it connects or does, and how it runs — two or three sentences.}

## How it works

{One picture in words: input, what the product does, outcome.}

1. {Step 1.}
2. {Step 2.}
3. {Step 3.}

## Who it is for

{The audience sentence plus the problem it removes.}

## What it is not

- {Non-goal 1, in customer words.}
- {Non-goal 2.}

## Next steps

- [Get started]({getting-started-path})
- [View the source]({SOURCE_REPOSITORY_URL})
```

## What to source from the spec

| Section | Source |
| ------- | ------ |
| What it is | The spec's purpose section |
| How it works | The spec's purpose and domain-logic sections — the core loop in customer words |
| What it is not | The spec's non-goals, in customer words |
| Who it is for | `docs-config.md` § Product → Audience |

## Product overview page

Same four topics (what it is, what it is not, who it is for, how it works), as a standard concept page ([concept-template.md](concept-template.md)) — no hero. Link onward to guide pages once they exist.
