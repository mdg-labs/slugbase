---
id: shared
title: Shared Page
sidebar_position: 9
---

# Shared Page

## Overview

The Shared page displays bookmarks and folders that have been shared with the current user by other users or teams. It provides a separate view for accessing shared content, distinguishing it from the user's own content.

![Shared Bookmarks Tab](../assets/shared-bookmarks-tab.png)

## Route

- **Path**: `/shared` (self-hosted) or **`/app/shared`** (SlugBase Cloud)
- **Authentication**: Required
- **Access**: All authenticated users

## Features

### Tabbed Interface

The page uses a tabbed interface with two sections:

1. **Bookmarks Tab** - Shows shared bookmarks
2. **Folders Tab** - Shows shared folders

![Shared Folders Tab](../assets/shared-folders-tab.png)

![Shared Bookmark Card Detail](../assets/shared-bookmark-card.png)

### Shared Bookmarks

Displays bookmarks shared with the user that are:
- Owned by other users
- Shared through teams the user is a member of
- Shared directly with the user

#### Bookmark Cards Display:

1. **Header Section**
   - Favicon (fetched from URL)
   - Bookmark title
   - "Shared" badge (always shown)

2. **Shared By Information**
   - User icon
   - Owner name or "Shared with you" (on SlugBase Cloud, owner email is not shown for privacy)

3. **URL Display**
   - Truncated URL with external link icon

4. **Metadata Tags**
   - Folder badges (up to 2 shown)
   - Tag badges (up to 2 shown)

5. **Forwarding URL** (if enabled)
   - Displays the canonical URL format: `/go/{slug}`
   - Copy button copies the full forwarding URL

6. **Actions**
   - **Open Button**: Opens bookmark URL in new tab
   - Edit/Delete buttons are NOT shown (shared bookmarks are read-only)

### Shared Folders

Displays folders shared with the user that are:
- Owned by other users
- Shared through teams the user is a member of
- Shared directly with the user

#### Folder Cards Display:

1. **Header Section**
   - Folder icon
   - Folder name
   - "Shared" badge (always shown)

2. **Shared By Information**
   - User icon
   - Owner name (on SlugBase Cloud, owner email is not shown)

3. **Sharing Indicators**
   - Team count badge (if shared via teams)
   - User count badge (if shared with individual users)

## User Interactions

### Viewing Shared Content

1. Navigate to the Shared page
2. Toggle between Bookmarks and Folders tabs
3. View shared items (read-only access)

### Opening Shared Bookmarks

1. Click the "Open" button on a bookmark card
2. Bookmark opens in a new tab
3. Original URL is accessed (not forwarded through SlugBase)

### Copying Forwarding URLs

1. If a shared bookmark has forwarding enabled, click the copy icon
2. The **canonical forwarding URL** is copied (e.g. `https://app.slugbase.app/go/<slug>`). The same link works for you and anyone the bookmark is shared with (login required).
3. Toast notification confirms copy

### Filtering

- Shared content is automatically filtered to show only items not owned by the current user
- No additional filtering options (by design, this is a dedicated "shared" view)

## Empty State

When no shared content exists:

**Bookmarks Tab:**
- Displays share icon
- Shows "No shared bookmarks yet" message

**Folders Tab:**
- Displays share icon
- Shows "No shared folders yet" message

## Related Pages

- [Bookmarks](bookmarks) - View own bookmarks
- [Folders](folders) - View own folders
- [Profile](profile) - User profile and settings

## Technical Details

- **Component File**: `frontend/src/pages/Shared.tsx`
- **State Management**: React hooks (`useState`, `useEffect`)
- **Filtering Logic**: Client-side filtering by `user_id`
- **Tab Management**: Local state with `useState`
- **API Client**: Custom API client with interceptors
