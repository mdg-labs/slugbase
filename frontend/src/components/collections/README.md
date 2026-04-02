# CollectionToolbar

Reusable toolbar for collection pages (Bookmarks, Folders, Tags). Renders only the controls passed via props; no collection-specific logic.

## Props API

| Prop | Type | Description |
|------|------|-------------|
| **Row 1 - Header** | | |
| `title` | `string` | Page title (e.g. "Bookmarks") |
| `count?` | `number` | Shown as "Title (count)" |
| `subtitle?` | `string` | e.g. "Showing X of Y" |
| `tabs?` | `{ value, onChange, options, ariaLabel? }` | Scope tabs (All / Mine / Shared) |
| `createButton?` | `{ label, onClick }` | Primary Create button |
| **Row 2 - Filter chips** | | |
| `filterChips?` | `{ chips, onRemove, onClearAll, clearAllLabel, clearAllAriaLabel }` | Renders when chips.length > 0 |
| **Row 3 - Toolbar** | | |
| `search?` | `{ value, onChange, onSubmit, placeholder?, ariaLabel? }` | Search input (Enter submits) |
| `folderFilter?` | `{ value, onChange, options, placeholder? }` | Folder select |
| `tagFilter?` | `{ value, onChange, options, placeholder? }` | Tag select |
| `sort?` | `{ value, onChange, options, className? }` | Sort select |
| `perPage?` | `{ value, onChange, options, label? }` | Per-page select |
| `viewMode?` | `{ value: 'card' \| 'list', onChange, cardLabel?, listLabel? }` | Card/list toggle |
| `pinnedToggle?` | `{ active, onClick, label }` | Pinned filter (utility) |
| `onImport?` | `() => void` | Import button (utility) |
| `importLabel?` | `string` | Default: "Import" |
| `onExport?` | `() => void` | Export button (utility) |
| `exportLabel?` | `string` | Default: "Export" |
| `bulkSelect?` | `{ onClick, label, disabled? }` | Bulk select (hidden when disabled) |
| `className?` | `string` | Optional wrapper class |

## Usage

- **Bookmarks**: title, count, subtitle, tabs, createButton, filterChips, search, folderFilter, tagFilter, sort, perPage, viewMode, pinnedToggle, onImport, onExport, bulkSelect.
- **Folders**: title, count, subtitle, tabs, createButton, filterChips, sort, perPage, viewMode.
- **Tags**: title, count, subtitle, createButton, filterChips, sort, perPage, viewMode.

## Modified files (refactor)

- `frontend/src/components/collections/CollectionToolbar.tsx` (new)
- `frontend/src/components/collections/index.ts` (new)
- `frontend/src/pages/Bookmarks.tsx`
- `frontend/src/pages/Folders.tsx`
- `frontend/src/pages/Tags.tsx`
