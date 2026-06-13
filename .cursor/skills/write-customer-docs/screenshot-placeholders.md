# Screenshot placeholders

Real screenshots are captured in a separate task. Until assets exist under `docs/public/assets/`, use **HTML comment placeholders** in MDX drafts so authors and reviewers know where visuals belong.

## Placeholder syntax

```mdx
<!-- screenshot:<asset-slug> -->
```

| Part | Rule |
|---|---|
| `screenshot:` | Fixed prefix — distinguishes from other comments |
| `<asset-slug>` | Lowercase kebab-case describing the screen; matches future filename without extension |

**Placement:** On its own line, typically after the section heading or before `<Steps>`.

### Examples

```mdx
## Open workspace settings

<!-- screenshot:settings-workspace-general -->

From the sidebar, choose **Settings**, then **Workspace**.
```

```mdx
<!-- screenshot:bookmarks-list-overview -->

## Steps
```

## Future asset mapping

When screenshots are captured, replace the comment with a root-absolute image (per `docs/public/README.md`):

```mdx
![Bookmarks list showing pinned and unpinned items](/assets/bookmarks-list-overview.png)
```

| Placeholder slug | Suggested capture | Product |
|---|---|---|
| `bookmarks-list-overview` | Bookmarks list with sample data | both |
| `bookmark-modal-edit` | Edit bookmark modal with slug field | both |
| `command-palette-go-mode` | Palette open in `go ` mode | both |
| `go-disambiguation` | Slug collision chooser | both |
| `settings-workspace-smtp` | Workspace → Email / SMTP section | selfhosted |
| `settings-account-mfa` | Account → Two-factor auth enroll | both |
| `login-error-generic` | Sign-in with generic error state | both |
| `dashboard-pinned-row` | Dashboard with pinned bookmarks | both |

Store files in `docs/public/assets/` — synced flat to `slugbase-docs` root `assets/`.

## Optional: visible callout placeholder

When a reviewer needs an inline reminder (not just a comment), wrap with a Documentation.AI callout:

```mdx
<Callout kind="info">
**Screenshot pending:** `settings-workspace-smtp` — capture Workspace → Email / SMTP on a self-hosted instance with mail admin UI enabled.
</Callout>
```

Use sparingly — prefer HTML comments in drafts; reserve callouts for review handoff.

## Page template integration

All skeletons in [page-templates.md](page-templates.md) include `<!-- screenshot:… -->` markers. When authoring:

1. Add a placeholder for every UI that is hard to describe in text alone.
2. Use slugs from the mapping table or add new slugs following the same naming pattern.
3. List new slugs in the Phase 6 summary for the screenshot capture follow-up.

## What not to do

- Do not commit proprietary or customer data in screenshots — use demo workspaces.
- Do not use relative image paths (`../assets/…`) — root-absolute only.
- Do not skip placeholders and leave long prose descriptions of pixel layout.
- Do not embed base64 images in MDX.

## Alt text (when replacing placeholders)

Follow active voice, describe the UI state not the filename:

```mdx
![Workspace settings with SMTP host and port fields filled in](/assets/settings-workspace-smtp.png)
```
