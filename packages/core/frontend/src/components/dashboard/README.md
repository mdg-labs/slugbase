# Dashboard components

Reusable sections for the Overview/Dashboard page.

## Component structure

| Component | File | Responsibility |
|-----------|------|----------------|
| **DashboardHeader** | `DashboardHeader.tsx` | Page title, optional subtitle, optional actions (uses shared `PageHeader`). |
| **StatsCardsRow** | `StatsCardsRow.tsx` | Row of three stat cards (bookmarks, folders, tags) with optional per-card usage/limit/CTA for cloud. |
| **PinnedSection** | `PinnedSection.tsx` | "Pinned" section: title, "View all" link, grid of bookmark cards (max 6), empty state. |
| **QuickAccessSection** | `QuickAccessSection.tsx` | "Quick access" section: title, optional subtitle, "View all" link, grid (max 6), empty state. |
| **MostUsedTagsSection** | `MostUsedTagsSection.tsx` | "Most Used Tags" section: clickable tag chips linking to `bookmarks?tag_id=<id>`. |

## StatCard usage-display API (cloud-ready)

In `StatCard` (and via `StatsCardsRow` → `StatItem.usage`), optional props for plan/usage display:

- **`secondaryLine?: string`** — Text below the main value (e.g. "+12 this week").
- **`used?: number`** — When set with `limit`, shows usage (e.g. "42 / 50").
- **`limit?: number`** — When set with `used`, enables usage line and optional progress bar.
- **`labelOverride?: string`** — Label for the usage line (e.g. "Bookmarks used").
- **`showProgress?: boolean`** — Show progress bar when `used` and `limit` are set (default `true`).
- **`progressVariant?: 'normal' | 'warning' | 'danger'`** — Bar color (primary / amber / destructive).
- **`cta?: { label: string; onClick: () => void }`** — Optional button (e.g. "Upgrade"); only pass in cloud.

In slugbase-core the dashboard does **not** pass `used`, `limit`, or `cta`. slugbase-cloud can pass these to show plan usage and upgrade CTA without changing layout.

## Visual / UX improvements

- **Header**: Dashboard now has a clear title ("Overview") and subtitle ("Quick access and recent activity").
- **Stats row**: Typography hierarchy (label secondary, value prominent); optional secondary line and usage/progress/CTA supported.
- **Section spacing**: Tighter vertical rhythm (`space-y-6`), consistent section headers (uppercase, muted).
- **Pinned / Quick Access**: Limited to 6 items on overview with "View all →"; Quick Access has subtitle "Most opened with shortcuts".
- **Most Used Tags**: Improved spacing (`gap-2.5`), same click-to-filter behavior.
