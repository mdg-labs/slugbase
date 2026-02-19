---
id: bookmarks
title: Bookmarks Page
sidebar_position: 6
---

# Bookmarks Page

## Overview

The Bookmarks page is the core of SlugBase, allowing users to create, view, edit, and manage their bookmarks. It features a modern card-based layout, filtering capabilities, and integration with folders and tags.

![Bookmarks Card View](../assets/bookmarks-card-view.png)

## Route

- **Path**: `/bookmarks` (self-hosted) or **`/app/bookmarks`** (SlugBase Cloud)
- **Authentication**: Required
- **Access**: All authenticated users

## Features

### Bookmark Management

- **Create Bookmarks**: Add new bookmarks with title, URL, optional slug, and forwarding
- **AI Suggestions** (optional): When enabled by admin, AI suggests title, tags, and slug as you enter a URL. Non-blocking; you can edit or ignore suggestions. On Cloud, available on Personal, Team, and Early Supporter plans.
- **Edit Bookmarks**: Modify existing bookmarks
- **Delete Bookmarks**: Remove bookmarks (with confirmation)
- **View Bookmarks**: Display all bookmarks in a responsive grid or list view
- **Bulk Actions**: Select multiple bookmarks for bulk operations (move, tag, share, delete)
- **Import/Export**: Import bookmarks from JSON or export your bookmarks
- **Pinned Bookmarks**: Pin important bookmarks for quick access

### View Modes

- **Card View**: Default grid layout with visual cards (1-6 columns based on screen size)
- **List View**: Compact table-like layout for power users
- **Compact Mode**: Reduced padding and font sizes for maximum density
- **View Toggle**: Switch between card and list views with toolbar buttons
- **Preferences**: View mode and compact mode preferences saved to localStorage

![Bookmarks List View](../assets/bookmarks-list-view.png)

![Bookmarks Table View](../assets/bookmarks-table-view.png)

### Filtering & Sorting

![Bookmarks Toolbar](../assets/bookmarks-toolbar.png)

- **Filter by Folder**: Dropdown to filter bookmarks by folder
- **Filter by Tag**: Dropdown to filter bookmarks by tag
- **Combined Filters**: Both filters can be used simultaneously
- **Reset Filters**: Clear all active filters with one click
- **Sort Options**:
  - Recently Added (default)
  - Alphabetical (A-Z)
  - Most Used (by access count)
  - Recently Accessed

### Global Search

![Global Search Modal](../assets/bookmarks-global-search.png)

- **Keyboard Shortcut**: Press `Ctrl+K` (or `Cmd+K` on Mac) from anywhere
- **Search Scope**: Searches across bookmarks, folders, and tags
- **Quick Navigation**: Click results to navigate directly
- **Search Bar**: Available in the top navigation bar

### Bookmark Cards

Each bookmark card displays:

1. **Header Section**
   - Favicon (fetched from URL or fallback icon)
   - Bookmark title (line-clamped to 2 lines)
   - **Shared Indicator**: Shows "Shared · X teams" with detailed tooltip
   - Selection checkbox (in bulk mode)

2. **URL Display**
   - Truncated URL with external link icon
   - Improved contrast for better readability

3. **Metadata Tags**
   - Folder badges (up to 2 shown in card view, 1 in list view, with icon)
   - Tag badges (up to 2 shown in card view, 3 in list view)
   - Clickable folder badges to filter by folder

4. **Forwarding URL** (if enabled)
   - Displays slug in format: `/{slug}`
   - Copy button to copy forwarding URL
   - Live preview in edit modal with copy functionality

5. **Actions**
   - **Open Button**: Opens bookmark URL in new tab
   - **Edit Button**: Opens edit modal (own bookmarks only)
   - **Delete Button**: Deletes bookmark with confirmation showing bookmark name (own bookmarks only)

### Card Design

- Modern rounded cards with hover effects
- Gradient icon backgrounds
- Consistent spacing and typography
- Dark/light mode support
- Responsive grid layout (1-6 columns in compact mode, 1-4 in normal mode)
- List view option for compact display
- Improved visual hierarchy with better contrast

## User Interactions

### Creating a Bookmark

![Create Bookmark Modal](../assets/bookmark-modal-create.png)

1. Click "Create Bookmark" button (top-right)
2. Fill in the bookmark modal:
   - Title (required)
   - URL (required)
   - **AI Suggestions** (optional, when enabled by admin): When a valid URL is entered, AI may suggest title, tags, and slug after a short delay. Suggestions appear automatically; you can edit or ignore them. Bookmark creation never waits for AI.
   - Enable forwarding (optional) - **Slug field appears only when forwarding is enabled**
   - Slug (required if forwarding enabled, optional otherwise)
   - **Live Preview**: See forwarding URL preview with copy button when slug is entered
   - Select folders (autocomplete multi-select with chips)
   - Select tags (autocomplete multi-select, create tags inline)
   - Share with teams/users (optional)
3. Click "Save"

![Bookmark Modal with Forwarding](../assets/bookmark-modal-forwarding.png)

### Editing a Bookmark

1. Click the edit icon on a bookmark card (own bookmarks only)
2. Modify fields in the modal
3. Click "Save"

### Deleting a Bookmark

1. Click the delete icon on a bookmark card (own bookmarks only)
2. Confirm deletion in the dialog
3. Bookmark is permanently removed

### Filtering Bookmarks

1. Use "Filter by Folder" dropdown to select a folder
2. Use "Filter by Tag" dropdown to select a tag
3. Filters apply immediately
4. **Reset Filters** button appears when filters are active
5. Click "Reset Filters" to clear all filters at once

### Sorting Bookmarks

1. Use the "Sort By" dropdown in the toolbar
2. Choose from:
   - Recently Added (newest first)
   - Alphabetical (A-Z)
   - Most Used (by access count)
   - Recently Accessed
3. Sort applies immediately

### Using Global Search

1. Press `Ctrl+K` (or `Cmd+K` on Mac) from anywhere
2. Type to search across bookmarks, folders, and tags
3. Results appear in a modal overlay
4. Click a result to:
   - Open bookmark (if bookmark)
   - Navigate to folder filter (if folder)
   - Navigate to tag filter (if tag)
5. Press `Esc` to close

### Bulk Actions

![Bulk Actions Bar](../assets/bookmarks-bulk-actions.png)

1. Click "Select Multiple" button to enter bulk mode
2. Select bookmarks using checkboxes
3. Use bulk action buttons:
   - **Move to Folder**: Assign selected bookmarks to folders
   - **Add Tags**: Add tags to selected bookmarks
   - **Share with Teams**: Share selected bookmarks
   - **Delete Selected**: Remove selected bookmarks
4. Click "Cancel" to exit bulk mode

### Copying Forwarding URL

1. If forwarding is enabled, click the copy icon next to the slug
2. URL is copied to clipboard
3. Toast notification confirms copy

## Empty State

![Bookmarks Empty State](../assets/bookmarks-empty-state.png)

When no bookmarks exist or filters return no results:

- Displays icon and descriptive message
- Shows multiple action buttons:
  - "Create your first bookmark"
  - "Import bookmarks"
  - "Learn how forwarding works" (links to guide)
- Clean, centered layout with helpful onboarding

## Search Engine Guide Link

At the bottom of the page, a note section provides:
- Information about setting up custom search engines
- Link to the Search Engine Guide page
- Helps users access bookmarks quickly from browser address bar

## Related Pages

- [Folders](folders) - Folder management
- [Tags](tags) - Tag management
- [Shared](shared) - Shared bookmarks view
- [Search Engine Guide](search-engine-guide) - Custom search engine setup

## Technical Details

- **Component File**: `frontend/src/pages/Bookmarks.tsx`
- **State Management**: React hooks (`useState`, `useEffect`)
- **Routing**: React Router
- **API Client**: Custom API client with interceptors
- **Toast Notifications**: Custom toast system
- **Icons**: Lucide React
