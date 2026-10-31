# Customer docs style guide

Single source of truth for voice, structure, and terminology. Referenced by [SKILL.md](SKILL.md) on every write pass.

## Voice and tone

| Rule | Detail |
| ---- | ------ |
| Audience | As `docs-config.md` § Product describes — end users, not developers of the product, unless it says otherwise |
| Person | Second person ("you") |
| Tense | Present tense |
| Steps | Imperative ("Click **Save**", not "The user should click") |
| Sentences | Short; one idea per sentence |
| Fluff | No marketing hype or empty superlatives |
| Deployment model | Describe only the ways the product is offered that `docs-config.md` § Product names — never hint at a hosted, managed or other edition it does not have |
| Language | English only (baseline) |

## Task orientation

Every **page doc** answers: **What can I do here, and how?**

| Do | Don't |
| -- | ----- |
| Describe user goals and actions | Describe React components, services, or DB tables |
| Lead with outcomes | Lead with architecture |
| Link to related tasks | Duplicate full procedures from other pages |

## Frontmatter

Every page starts with a `---` block (the templates carry it). Fields:

| Field | Required | Rule |
| ----- | -------- | ---- |
| `title` | yes | Title Case, the page's name as the reader knows it |
| `description` | yes | One sentence in sentence case; what the reader can do or learn |
| `edition` | yes | `ce`, `cloud` or `both`, chosen as below |
| `since` | where known | A version such as `1.0.0` or `1.2.0-rc.1`, chosen as below |
| `order` | where known | An integer; lower comes first among pages of one folder |

No other field is allowed, and `pnpm docs:check` rejects it.

**Choosing `edition`.** Take it from the spec and the entitlement rules, never from how the page happens to read:

- `both` — the behaviour is the same wherever the product runs. This is the default for anything the app does for a signed-in person.
- `cloud` — the behaviour exists only in the managed service (for example a plan-gated feature the spec marks as Cloud-only).
- `ce` — the page applies only to a self-hosted installation.

When a page is `both` but one paragraph differs, keep `both` and mark the difference (§ Components). When you cannot tell, ask; do not guess.

**Choosing `since`.** It is the first released version that has the behaviour. Read it from the release notes under `docs/releases/` or from the release tags, and write that version. When no release has shipped it, or you cannot verify which, leave the field out and list the page under **Open questions**. Never write a version you did not read. For a release note, `since` equals the file name's version (`docs/releases/1.2.0.md`).

**Choosing `order`.** Getting started is `1`; give the others multiples of ten in reading order, so a page can be inserted later. Leave the field out when the order does not matter.

## Components

Pages are Markdown or MDX under the contract of doc 09 §3.5. Only these components exist, and only in an `.mdx` page:

| Component | Use |
| --------- | --- |
| `Callout` | A note, tip or warning, and a difference between editions |
| `EditionBadge` | A small badge for one feature, option or row that exists in one edition only (`<EditionBadge edition="cloud" />`) |
| `Screenshot` | The screenshot placeholder (§ Screenshots) |
| `Tabs`, `Tab` | Alternatives, for example one tab per way to run the product |
| `Steps`, `Step` | A numbered procedure with titled steps |

Attribute values are string, number or boolean literals; no `{expression}`.

`pnpm docs:check` rejects everything else: any other component, raw HTML (including `<!-- comments -->`, `<img>` and `<a>`), `import` and `export`, a JavaScript expression in the text, a remote image, a `.svg`, an image over 1 MiB, an `http://` link (a bare address in the text counts as a link) and a link that does not resolve. A `.md` page is plain Markdown, so a component in it counts as raw HTML: use `.mdx` for any page that carries one.

Do not add `Callout` to every page. The site already shows the page's `edition` and `since`; add a note or a badge only where a part of a `both` page differs by edition.

## Page doc structure

Use [page-doc-template.md](page-doc-template.md). Required sections:

1. **One-sentence purpose** — first text of the body (the site renders `title` as the heading; see `docs-config.md` § Frontmatter)
2. **Prerequisites** — what must be true before starting (or "None")
3. **Step-by-step sections** — one `##` heading per key action on the page
4. **Field and option reference** — table of labels users see in the UI
5. **Troubleshooting** — common problems for this page only
6. **Related pages** — links to adjacent docs

## Getting started structure

Use [getting-started-template.md](getting-started-template.md).

- Happy path from signup/login (or equivalent) to **first success moment**
- **≤ 10 numbered steps** — link to page docs instead of duplicating detail
- End with **Next steps** table and FAQ link
- Numbered procedures may use `Steps` and `Step` (an `.mdx` page)

## Terminology

| Rule | Detail |
| ---- | ------ |
| Glossary | `docs-config.md` § Glossary — internal term → customer-facing term |
| Consistency | One term per concept across all pages |
| Unknown mapping | **Ask the user** — never guess |
| Forbidden in customer docs | Internal entity names, DB column names, code identifiers, env var names, API route paths meant for integrators only |

## Accuracy

| Rule | Detail |
| ---- | ------ |
| Source of truth | The spec docs `docs-config.md` § Product names (CLAUDE.md `### Design docs`), then app code (read-only) and its UI label files |
| Unverified flows | List under **Open questions** in the proposal — do not publish |
| Fabrication | Never invent features, buttons, fields, or behaviour |
| UI text | Quote visible labels from the app when known; do not invent label copy |
| Screenshots | Never fabricate images; use the placeholder format `docs-config.md` § Screenshots names, only when its policy allows |

## Security and privacy

Never include in customer docs:

- Secrets, API keys, tokens, or credentials — and token-shaped example strings (write `<your API token>`)
- Internal-only URLs (staging, admin panels, VPN endpoints)
- Admin-only or operator-only endpoints
- Personal data examples (use placeholders like `you@example.com`)

## Screenshots

| Policy (from config) | Action |
| -------------------- | ------ |
| PLACEHOLDERS | Insert `<Screenshot alt="short description" />` where a visual helps: the allow-listed component with no `src`, in an `.mdx` page. The `alt` says what the screen shows |
| NONE | No image placeholders |

This skill **never** captures screenshots, never writes an HTML comment as a placeholder (the contract refuses it) and never sets `src` to a file that does not exist: a person adds the image next to the page later and then sets `src` to its relative path.

## Navigation and naming

- File names: **kebab-case**
- Doc titles: Title Case for H1; sentence case for descriptions
- Cross-links: a relative path to the page file, extension included (`../concepts/slugs.md`, `sharing.mdx`), or a `/docs/...` route; never a root-absolute link outside `/docs/`
- External links: the full `https://` address; `http://` and `mailto:` are refused
- Page order: set `order` (Getting started first, then high-traffic flows, then settings/admin if user-facing); there is no sidebar file

## FAQ and concept pages

**Concept pages** explain one product idea (e.g. "Workspaces", "Roles") without walking through a single screen. Use [concept-template.md](concept-template.md).

**FAQ** answers recurring questions in Q&A format — link to page docs for procedural detail; do not duplicate full step lists. Use [faq-template.md](faq-template.md).

## Review checklist (before marking coverage `current`)

- [ ] Purpose sentence matches what the page actually does
- [ ] Every documented action exists in code or spec
- [ ] Field table matches visible UI labels
- [ ] No internal jargon (glossary applied)
- [ ] Related links resolve
- [ ] Frontmatter has `title`, `description` and `edition`; `edition` and `since` follow the rules above
- [ ] Only allow-listed components, and only in an `.mdx` page; no raw HTML
- [ ] `pnpm docs:check` passes
- [ ] English only; short sentences
- [ ] No secrets or internal URLs
