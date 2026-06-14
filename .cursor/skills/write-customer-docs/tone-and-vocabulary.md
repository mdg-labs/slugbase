# Tone and vocabulary

Customer docs explain **what readers can do in SlugBase**, not how the codebase is structured. English only for `slugbase-docs` MDX.

## Language scope

| Surface | Locales | Notes |
|---|---|---|
| Public docs (`slugbase-docs/`) | **English only** | No German MDX, no bilingual pages |
| Web app UI | English + German (`en.json`, `de.json`) | Use `en.json` for terminology discovery, not as translated doc output |

If a user asks for German public documentation, defer to a separate i18n initiative — out of scope for v1 public docs.

## Voice and style

| Principle | Do | Don't |
|---|---|---|
| Audience | Write for technical readers (developers, admins) using the product | Write for SlugBase contributors |
| Person | Second person ("you") for instructions | Passive voice ("the bookmark is created") |
| Tense | Present for current product behaviour | Future tense for shipped features |
| Sentences | Short, direct | Long chains with nested clauses |
| Structure | Lead with outcome; prerequisites before steps | Bury the goal after architecture essay |
| Jargon | Define on first use ("workspace", "slug") | Assume repo institutional knowledge |
| Implementation | Describe user-visible results | Name internal services, modules, or env flags |

## Product vocabulary (spec §3 — mandatory)

Use these terms in all public docs. Full glossary: `slugbase/docs/internal/slugbase-mvp-spec.md` §3.

| Use | Never use | Notes |
|---|---|---|
| workspace | organization, org, tenant | Top-level container for bookmarks, members, billing |
| folder | collection | Container for organizing bookmarks |
| pinned / pinning | favorite, starred, bookmarked | Only prominence mechanism |
| member | user (for workspace membership) | "User account" OK for global identity |
| slug | alias, shortlink, keyword | |
| forwarding / go | redirect (in user-facing copy) | `/go/<slug>` is fine in technical steps |
| workspace admin | org admin | |
| instance-wide admin | super admin, site admin | Self-hosted operator role |

## Deployment framing

Describe what the **reader sees**, not deployment-mode branches:

| Good | Bad |
|---|---|
| "On SlugBase Cloud, billing settings appear under **Settings → Billing**." | "When `billingEnabled` is true…" |
| "On self-hosted instances, you configure SMTP in workspace settings." | "In self-hosted mode the code path…" |
| "Team plans include member management." | "If `isCloud` then…" |

Entitlement-gated features: explain plan requirements ("available on Team plans") per spec §12 — never reference the entitlements engine by name in customer docs.

## Spec-aligned product terms

| Topic | Preferred public phrasing |
|---|---|
| Paid individual tier | **Personal** (not "Pro") |
| Free bookmark cap | **50** bookmarks |
| API tokens | Not plan-gated in v1 |
| Slug resolution | Private to workspace; signed-in members only |
| Bookmark editing | Modal editor — no "detail page" |

Divergences from the design prototype are catalogued in spec §23.4 — follow the spec.

## Security-aware copy

Match non-enumerating auth patterns from the app (spec §5):

- Password reset: "If an account exists for this email, we sent instructions."
- Do not promise whether an email is registered.

Never document bypasses, CSRF exemptions, or internal admin backdoors.

## Formatting habits

- **Bold** for UI labels the reader clicks or sees (`**Settings**`, `**Add bookmark**`).
- `code` for paths, slugs, keys, and keyboard shortcuts (`/go/docs`, `⌘K`).
- Root-absolute doc links: `[Quick start](/selfhosted/quick-start)`.
- Tables for limits, shortcuts, and troubleshooting matrices.

## Heading discipline

- One primary concept per page.
- `##` sections self-contained (Documentation.AI retrieval).
- Descriptive headings: "Configure SMTP" not "Configuration".
- Parallel grammar in sibling headings within a group.

## Examples

See [examples.md](examples.md) for side-by-side good vs bad excerpts.
