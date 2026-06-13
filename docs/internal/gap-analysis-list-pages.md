# Gap Analysis — Bookmarks, Tags & Folders Pages

## Purpose

Compare the current frontend implementation of the three list pages (Bookmarks, Tags, Folders) against the V1 design prototype at `docs/internal/design-prototype/V1/`, and against each other. Identify gaps, inconsistencies, and missing features. No code changes — findings only.

**Last updated**: 2026-06-08
**Prototype reference**: `docs/internal/design-prototype/V1/prototype/{App.jsx,BookmarkViews.jsx,TagsApp.jsx,FoldersApp.jsx,app.css,pages.css}`
**Code reference**: `packages/web/app/routes/{bookmarks,tags,folders}/`

---

## 1. Shell & Page Structure — The Core Divergence

### Mockup structure (all 3 pages share this)

```
<div class="app">                         ← 248px sidebar | 1fr main grid
  <Sidebar />
  <main class="main">                     ← flex column, background: var(--canvas)
    <TopBar />                            ← breadcrumbs ONLY (no page title)
    <div class="toolbar">                 ← filter/sort row, border-bottom, flat
    <div class="content">                 ← padding: var(--sp-7)
      {page-specific content}
    </div>
  </main>
</div>
```

The page identity comes from the **TopBar breadcrumb**, not a page-level `<h1>`. There is no standalone page title anywhere.

### Current code — three completely different outer wrappers

| Page | Outer Wrapper | Has `<h1>` Title? | Has Subtitle? |
|------|--------------|-------------------|---------------|
| **Bookmarks** | `<div className="flex w-full flex-col">` | No (correct) | No (correct) |
| **Tags** | `<div className="flex h-full flex-col overflow-hidden">` | **Yes** — "Tags" + subtitle with count | **Yes** — count |
| **Folders** | `<div className="mx-auto flex w-full max-w-6xl flex-col gap-sp-6 px-sp-6 py-sp-8">` | **Yes** — "Folders" + subtitle with count | **Yes** — count |

**Verdict**: Tags and Folders should NOT have their own page title. The mockup has NO page-level heading — only the TopBar breadcrumb (`Tags > All`, `Folders > All`, `Bookmarks`). The title + subtitle in the current code is a complete fabrication not present in the mockup.

---

## 2. Per-Page Structural Comparison

### 2.1 Bookmarks Page

#### Mockup (`App.jsx`)
```jsx
<main className="main">
  <TopBar crumb="Bookmarks" count={total} />
  <Toolbar />                             ← search + chips (folder, tags, pinned, scope) + count + sort + view toggle
  {upsell banner}                         ← between toolbar and content
  <div className="content">               ← padding: var(--sp-7)
    {loading ? SkeletonGrid : empty || grid/table}
  </div>
  <Pager />
  <BulkBar />
</main>
```

#### Current code (`BookmarkListPage.tsx`)
```tsx
<div className="flex w-full flex-col">    ← no .main shell (that's in AppChrome)
  {cap banner}                            ← inside px-sp-6 pt-sp-6
  <div className="flex flex-wrap ...">    ← toolbar: border-b, px-sp-6, py-sp-4 (vs mockup .toolbar styles)
    search + chips + count + sort + view toggle
  </div>
  <div className="p-sp-6">               ← grid/table content AND pagination inside this
    {grid table view}
  </div>
  <BulkBar />
</div>
```

**Structural differences:**
1. ✅ Bookmarks is closest to mockup — no rogue page title, toolbar + content + pagination structure matches
2. ⚠️ Toolbar padding: `px-sp-6 py-sp-4` vs mockup `.toolbar` which has `padding: var(--sp-2) var(--sp-7)` = 8px 28px
3. ⚠️ Content padding: `p-sp-6` vs mockup `.content` which has `padding: var(--sp-7)` = 28px
4. ⚠️ Cap banner position: code puts it above toolbar with `px-sp-6 pt-sp-6`; mockup puts it between toolbar and content
5. ❌ **Pinned section head missing**: mockup splits pinned bookmarks with a `SectionHead` ("Pinned" · pin icon · count · hairline) when on page 1 grid view. Code interleaves pinned items in the grid with no visual separation.
6. ❌ **Skeleton is a generic list**: mockup shows 9 card-shaped skeletons (`.sk-card` grid); code uses `SkeletonList` with 8 generic rows
7. ❌ **Empty state is custom inline**: mockup uses its own `.empty` class with logo; code has similar markup but bypasses the shared `@slugbase/ui` `EmptyState` component that Tags and Folders use

**What the mockup BookmarkCard contains that code matches:**
- ✅ Favicon/monogram
- ✅ Title, URL
- ✅ Slug line or "No slug" placeholder
- ✅ Folder dot + name
- ✅ Up to 2 tag chips
- ✅ Relative time
- ✅ Scope icon
- ✅ Pin button (click-outside, filled when pinned)
- ✅ Hover-reveal checkbox with selection styling

**What the mockup TableHead/BookmarkRow contains:**
- ✅ Checkbox column, sortable Bookmark column, Slug, Folder, Tags, Accessed/Uses, actions columns
- ✅ Sticky header with sorted indicator
- ✅ Sort toggles between accessed time and access count

---

### 2.2 Tags Page

#### Mockup (`TagsApp.jsx`)
```jsx
<main className="main" style={{ overflow: "hidden" }}>
  <TopBar crumbIcon="hash" crumbLabel="Tags" crumbSub="All" count={...} />
  <div className="toolbar">
    <div className="field">               ← search (220px wide)
      <input placeholder="Search tags…" />
    </div>
    <div className="toolbar-spacer" />
    <span className="t-mono">{count}</span>
    <sort chip dropdown>                  ← "Sort by" chip
    <button className="btn btn--primary btn--sm">New tag</button>
  </div>
  <div className="tags-layout" style={{ gridTemplateColumns: hasPanel ? "1fr 360px" : "1fr" }}>
    <div className="tags-list-col">       ← overflow-y: auto, padding: var(--sp-7)
      {loading ? TagSkeleton : empty || tag-table}
    </div>
    {detail panel}
  </div>
</main>
```

#### Current code (`TagListPage.tsx`)
```tsx
<div className="flex h-full flex-col overflow-hidden">
  <div className="flex min-h-0 flex-1" style={{ gridTemplateColumns... }}>
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="border-b px-sp-6 py-sp-6">    ← PAGE HEADER BLOCK (wrong)
        <div className="mb-sp-5 flex items-end">
          <div>
            <h1>Tags</h1>                            ← ❌ FABRICATED TITLE
            <p>{subtitle}</p>                        ← ❌ FABRICATED SUBTITLE
          </div>
        </div>
        <div className="flex flex-wrap gap-sp-3">    ← toolbar INSIDE the header block
          search + spacer + count + sort + new button
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-sp-6 py-sp-4">   ← wrong padding
        {NewTagInline || empty || tag-table}
      </div>
    </div>
    {detail panel}
  </div>
</div>
```

**Structural differences:**
1. ❌ **Has its own page title (`<h1>`)** — mockup has NO title, only TopBar breadcrumbs. Count and identity come from TopBar.
2. ❌ **Has a page subtitle** — mockup has no subtitle. The tag count is shown in the toolbar as a mono span, not a descriptive subtitle.
3. ❌ **Toolbar is nested inside a header block with border-bottom** — mockup toolbar is the flat `.toolbar` class (padding `var(--sp-2) var(--sp-7)`, border-bottom). The extra wrapper and padding add visual weight that doesn't exist.
4. ⚠️ **Search field width differs**: code `min-w-[180px] max-w-[220px]` with `bg-[color:var(--base)]`; mockup `width: 220px` with `bg: var(--raised)`
5. ⚠️ **New tag creates an inline form** — mockup "New tag" button in toolbar clicks to show a toast (prototype placeholder). The inline form at the top of the list is a reasonable implementation but adds extra content before the table. Mockup has no inline form.
6. ⚠️ **Content padding**: `px-sp-6 py-sp-4` vs mockup `.tags-list-col` has `padding: var(--sp-7)`
7. ✅ Column layout matches: `1fr 180px 80px 80px`
8. ✅ Inline rename and delete confirmation match mockup patterns
9. ❌ **Detail panel missing bookmark list**: mockup panel body shows a scrollable list of tagged bookmarks (favicon, title, URL, slug). Code only shows a placeholder message ("Click a tag to view details" or "Bookmarks tagged with X go here"). **This is the single biggest missing feature**.

**Mockup tag detail panel contains:**
- Header: `#tag-name` + close X + bookmark count + scope ("User-private")
- Body: scrollable list of tagged bookmarks (favicon, title, URL, slug)
- Footer: "View all in Bookmarks" + "Rename" + "Delete" buttons

**Current code tag detail panel contains:**
- Header: `#tag-name` + close X + bookmark count
- Body: placeholder text only ("Click a tag to view details for its bookmarks.") — NO bookmark list
- Footer: "View all in Bookmarks" + "Rename" + "Delete" buttons (matches mockup)

---

### 2.3 Folders Page

#### Mockup (`FoldersApp.jsx`)
```jsx
<main className="main">
  <TopBar crumbIcon="folder" crumbLabel="Folders" crumbSub="All" count={...} />
  <div className="toolbar">
    <div className="field">               ← search (240px wide)
      <input placeholder="Search folders…" />
    </div>
    <scope chip dropdown>                 ← Scope chip (All/Mine/Shared with me/Shared by me)
    <div className="toolbar-spacer" />
    <span className="t-mono">{count}</span>
    <sort chip dropdown>
    <button className="btn btn--primary btn--sm">New folder<Kbd>N</Kbd></button>
  </div>
  <div className="content">
    {loading ? FolderSkeleton : empty || folder-list}
  </div>
</main>
```

#### Current code (`FolderListPage.tsx`)
```tsx
<div className="mx-auto flex w-full max-w-6xl flex-col gap-sp-6 px-sp-6 py-sp-8">
  <header className="flex flex-wrap items-end justify-between gap-sp-4">
    <div>
      <h1>Folders</h1>                                 ← ❌ FABRICATED TITLE
      <p>{subtitle}</p>                                ← ❌ FABRICATED SUBTITLE
    </div>
  </header>
  <div className="flex flex-wrap items-center gap-sp-3 rounded-lg border ... px-sp-5 py-sp-4">
    ← ❌ TOOLBAR WRAPPED IN CARD
    search + scope filter + spacer + count + sort + new button
  </div>
  {empty state (wrapped in dashed border div) || folder list}
  {rename/delete/new modal dialogs}
</div>
```

**Structural differences:**
1. ❌ **Has page title + subtitle** — mockup has NO title, only TopBar breadcrumbs
2. ❌ **Max-width container** (`max-w-6xl mx-auto`) — mockup content is full-width within `main`. No centering, no max-width.
3. ❌ **Outer padding** (`gap-sp-6 px-sp-6 py-sp-8`) — mockup `.content` has `padding: var(--sp-7)`. Very different spacing model.
4. ❌ **Toolbar is a rounded card** (`rounded-lg border`) — mockup toolbar is a flat `.toolbar` div with `border-bottom` only. No rounded corners, no standalone border wrapper. This makes the toolbar look like a card floating in space instead of a page-level toolbar.
5. ❌ **Empty state wrapped in dashed border div** — mockup empty state is just centered content inside `.content` with the `.folder-empty` class.
6. ❌ **Modals for rename/delete/new** — mockup would use inline actions (same pattern as Tags: inline rename input, inline delete confirmation bar). The prototype uses toast placeholders for these, but the design language clearly follows the Tags pattern.
7. ⚠️ **Folder rows are card-like `<li>`** with `rounded-lg border` — mockup `FolderRow` is a flat `flex` row with `border-radius: var(--r-md)` and `border: 1px solid transparent` that becomes visible on hover. The current code adds border always, making rows look like cards.
8. ❌ **Missing owner column**: mockup shows owner name for `shared-with-me` folders. Current code only shows a SharingLabel badge.
9. ❌ **Missing "Share settings" in More menu**: mockup More menu has Open in Bookmarks, Rename, Share settings, separator, Delete folder. Code has Open, Rename, separator, Delete (no Share settings).

**Mockup FolderRow contains:**
- `f-dot` (12px colored square)
- `f-name` (bold, flex:1)
- `f-count` (mono, bookmark count)
- `ScopeLabel` (Private/Team/N members/Shared with you)
- Owner name (when `shared-with-me`)
- `f-modified` (relative time, right-aligned)
- Hover-revealed actions: Open, Edit, Share, More (dropdown with Open in Bookmarks, Rename, Share settings, Delete folder)

**Current code FolderRow contains:**
- `FolderColorDot` (10px, fallback to `var(--fg-faint)`)
- Name, ScopeIcon, SharingLabel, bookmark count, relative time
- Hover-revealed actions: Open, Rename, More (Radix DropdownMenu with Open in Bookmarks, Rename, separator, Delete)
- ❌ No Share button (direct)
- ❌ No owner name column
- ❌ Row has permanent border (`rounded-lg border`) vs mockup's transparent-then-visible-on-hover

---

## 3. Tags & Folders Should Be Nearly Identical (But Aren't)

The mockup deliberately makes Tags and Folders structurally identical:

| Element | Mockup Tags | Mockup Folders | Code Tags | Code Folders |
|---------|-------------|----------------|-----------|-------------|
| Page heading | None (TopBar only) | None (TopBar only) | `<h1>` + subtitle | `<h1>` + subtitle |
| Toolbar | `.toolbar` — flat, border-bottom | `.toolbar` — flat, border-bottom | Nested inside header block | Card with rounded-lg border |
| Toolbar items | search (220px) · spacer · count · sort · "New" | search (240px) · scope chip · spacer · count · sort · "New" | search (180-220px) · spacer · count · sort · "New" | search (180-240px) · scope · spacer · count · sort · "New" |
| Content padding | `.tags-list-col` = `var(--sp-7)` | `.content` = `var(--sp-7)` | `px-sp-6 py-sp-4` | N/A (outer has `py-sp-8`) |
| Empty state | `.tags-placeholder` — centered, icon, text | `.folder-empty` — centered, icon, heading, text, button | Uses shared `EmptyState` (✅) | Uses shared `EmptyState` (✅) BUT wrapped in dashed border div (❌) |
| Row style | `.tag-trow` — flat, transparent border → visible on hover | `.folder-row` — flat, transparent border → visible on hover | `.tag-trow` — flat, transparent → hover bg (✅) | Card-like `<li>` with permanent border (❌) |
| Edit pattern | Inline rename input | Inline (would match Tags) | Inline rename input (✅) | Modal dialog (❌) |
| Delete pattern | Inline confirmation bar | Inline (would match Tags) | Inline confirmation bar (✅) | Modal dialog (❌) |
| Outer wrapper | `main.main` (from shell) | `main.main` (from shell) | `flex h-full flex-col overflow-hidden` (self-contained) | `mx-auto max-w-6xl flex-col gap-sp-6 px-sp-6 py-sp-8` (self-contained) |

---

## 4. Empty State Inconsistencies

| Page | Mockup Empty State | Code Empty State | Gap |
|------|-------------------|-----------------|-----|
| **Bookmarks** | Logo (80px), `h3` heading, `p` description, "New bookmark" (primary) + "Import from browser" (ghost) | Custom inline markup: logo (80px), heading, description, "New bookmark" (primary) + "Import from browser" (ghost) | Functionally identical but bypasses shared `@slugbase/ui` `EmptyState` |
| **Bookmarks (filtered)** | Logo, `h3` "No bookmarks match these filters", `p` description, "Clear filters" (secondary) | Heading, description, "Clear filters" button | Same shape, uses inline markup not shared component |
| **Tags (no tags)** | `#` icon (36px), `p` "No tags yet — create one to start organizing" | `HashIcon` (36px), title "No tags yet", description "Create a tag to start organizing…" | ✅ Uses shared `EmptyState` |
| **Tags (search)** | `#` icon, `p` "No tags match `{q}`", "Clear search" button | Title "No tags match {q}", "Clear search" button | ✅ Uses shared `EmptyState` |
| **Folders (no folders)** | `folder-open` icon (40px), `h3` "No folders yet", `p` "Create a folder to organise your bookmarks.", "New folder" (primary) | `FolderOpenIcon` (40px), title, description, "New folder" button | ✅ Uses shared `EmptyState` but **wrapped in dashed border div** |
| **Folders (filtered)** | `folder-open` icon, `h3` "No folders match", `p` "Try a different search or scope filter.", "Clear filters" (secondary) | Title, description, "Clear filters" button | ✅ Uses shared `EmptyState` but **wrapped in dashed border div** |

Bookmarks is the outlier — it uses custom markup instead of the shared `EmptyState` component.

---

## 5. Skeleton / Loading States

| Page | Mockup Skeleton | Code Skeleton | Gap |
|------|----------------|--------------|-----|
| **Bookmarks** | 9 card-shaped skeletons (`.sk-card`) in grid | 8 generic rows (`SkeletonList`) | Wrong shape — should be card grid not list rows |
| **Tags** | 8-row shimmer with tag table columns (name, usage bar, count, actions) | 8-row custom skeleton with tag columns + optional panel gutter | ✅ Matches mockup |
| **Folders** | 4-row shimmer with dot, name, count, time | 6 rows (`SkeletonList`) | Wrong row count and shape — should be 4 folder-shaped rows |

---

## 6. Toolbar Components — Shared vs. Duplicated

The mockup has ONLY TWO toolbar patterns:
1. **Bookmarks toolbar**: search + multiple filter chips + count + sort + view toggle
2. **Tags/Folders toolbar**: search + 0-1 filter chips + spacer + count + sort + "New" button

Tags and Folders share the EXACT SAME `.toolbar` CSS class.

In the current code:
- Bookmarks has its own inline toolbar
- Tags has its own inline toolbar (inside header block)
- Folders has its own inline toolbar (inside a rounded card)
- The shared `ListPageToolbar`, `FilterChipMenu`, `ListSearchField`, `ListResultCount` components exist but are unused by any page

---

## 7. Summary of Discrepancies by Severity

### Critical (Makes pages look like a different app)
1. **Tags and Folders have fabricated page titles (`<h1>`)** — mockup has no page-level heading; identity comes from TopBar breadcrumbs only
2. **Folders has wrong outer wrapper** — `max-w-6xl mx-auto` centering + `py-sp-8` padding not in mockup
3. **Folders toolbar is a rounded card** — mockup toolbar is flat with only border-bottom

### High (Key features missing or wrong interaction model)
4. **Tags detail panel missing bookmark list** — mockup shows tagged bookmarks; code has placeholder text
5. **Folders uses modal dialogs for rename/delete** — mockup follows same inline pattern as Tags
6. **Bookmarks pinned section head missing** — mockup splits pinned items with a visual divider
7. **Folders More menu missing "Share settings" item** — present in mockup, absent in code
8. **Folders missing owner column** for `shared-with-me` folders

### Medium (Layout/padding/spacing mismatches)
9. **Bookmarks empty state bypasses shared `EmptyState` component**
10. **Bookmarks toolbar padding differs** (`py-sp-4` vs `var(--sp-2)`)
11. **Bookmarks content padding differs** (`p-sp-6` vs `var(--sp-7)`)
12. **Bookmarks skeleton is wrong shape** (list rows vs card grid)
13. **Bookmarks cap banner position** (above toolbar vs between toolbar and content)
14. **Tags search field width** (`min-w-[180px] max-w-[220px]` vs `width: 220px`)
15. **Tags content padding** (`px-sp-6 py-sp-4` vs `var(--sp-7)`)
16. **Tags toolbar nested in header block** — should be standalone `.toolbar`
17. **Folders empty state wrapped in dashed border div** — should be plain centered content
18. **Folders folder rows have permanent border** — mockup shows border only on hover
19. **Folders skeleton has 6 rows not 4**
20. **All three pages duplicate toolbar/search/filter implementations** instead of using shared `list/` components

### Low (Cosmetic)
21. BookmarkCard pin button position (absolute top-right vs inline in meta row)
22. No TopBar search trigger chip, theme toggle, or notifications
23. Bookmarks search uses debounced navigate; Folders uses native `<Form>`
24. CSRF pattern differs between Bookmarks (cookie-credential only) and Tags/Folders (explicit CSRF token fetch)

---

## 8. ⛔ Emoji Used as Icons — Strict Violation

Per `04-naming.mdc` and the design system (`11-design-system.mdc`), SlugBase uses **proper icon libraries** (Lucide via `lucide-react`, inline SVGs). Emojis are never acceptable as UI icons — they render inconsistently across OS/browser, break i18n tone, and violate the design system.

### Current violations in `packages/web/`

| File | Line | Emoji | Should Be |
|------|------|-------|-----------|
| `DashboardFoldersOverview.tsx` | 24 | `📁` | `FolderIcon` (lucide or inline SVG) |
| `DashboardQuickAccess.tsx` | 27 | `⚡` | `ZapIcon` (lucide or inline SVG) |
| `DashboardOnboardingChecklist.tsx` | 137 | `☑` | `CheckSquareIcon` (lucide) or check icon |

Also in the broader codebase (`✓` and `×` as UI elements, not emoji but same anti-pattern):

| File | Line | Char | Should Be |
|------|------|------|-----------|
| `TagListPage.tsx` | 524 | `✓` (raw text checkmark in sort dropdown) | `CheckIcon` SVG |
| `FolderListPage.tsx` | 562 | `✓` (raw text checkmark in sort dropdown) | `CheckIcon` SVG |
| `DashboardOnboardingChecklist.tsx` | 199 | `✓` (checkbox done indicator) | `CheckIcon` SVG |
| `DashboardOnboardingChecklist.tsx` | 158 | `×` (dismiss button) | `XIcon` (lucide) |
| `ScopeFilter.tsx` | 104 | `✓` (inline checkmark) | `CheckIcon` SVG |
| `PlanComparisonTable.tsx` | 32 | `✓` (feature indicator) | `CheckIcon` SVG |

The marketing package (`packages/marketing/`) uses `✓` and `\\❯` inside CSS-generated content and `.astro` templates — those are design-constrained and acceptable there (not app UI).

**Rule**: Every icon in `packages/web/` must be from `lucide-react` or an inline SVG component. Zero raw text symbols.

---

## 9. The Fix Strategy

The mockup prescribes a **shared page template**:

```
<main>                    ← AppChrome provides this
  <!-- TopBar breadcrumb handled by AppChrome via ListPageMetaProvider -->
  <div class="toolbar">  ← flat, border-bottom, flex-wrap, padding
    search + filter chips + spacer + count + sort + new/view toggle
  </div>
  <div class="content">  ← overflow-y: auto, padding: var(--sp-7)
    {empty, skeleton, or content}
  </div>
  <!-- Optional: Pager, BulkBar, modals -->
</main>
```

Tags and Folders should be **structurally identical** to each other (with content-area differences only). Bookmarks adds a pinned section head, bulk bar, and pagination — but the toolbar + content shell should match.
