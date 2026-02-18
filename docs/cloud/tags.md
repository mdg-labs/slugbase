---
id: tags
title: Tags Page
sidebar_position: 8
---

# Tags Page

## Overview

The Tags page allows users to create, edit, and manage tags for organizing bookmarks. Tags provide a flexible labeling system for bookmarks, enabling users to categorize content across multiple dimensions.

![Tags Overview](../assets/tags-overview.png)

## Route

- **Path**: `/tags` (self-hosted) or **`/app/tags`** (SlugBase Cloud)
- **Authentication**: Required
- **Access**: All authenticated users

## Features

### Tag Management

- **Create Tags**: Add new tags with a simple name
- **Edit Tags**: Modify tag names
- **Delete Tags**: Remove tags (with confirmation)
- **View Tags**: Display all tags in a responsive grid

### Tag Cards

Each tag card displays:

1. **Header Section**
   - Tag icon (purple gradient background)
   - Tag name (truncated if too long)

2. **Actions**
   - **Edit Button**: Opens edit modal
   - **Delete Button**: Deletes tag (with confirmation)

### Card Design

- Modern rounded cards with hover effects
- Purple gradient icon backgrounds
- Consistent spacing and typography
- Dark/light mode support
- Responsive grid layout (1-5 columns based on screen size, larger than other cards)

## User Interactions

### Creating a Tag

![Create Tag Modal](../assets/tag-modal-create.png)

1. Click "Create Tag" button
2. Enter tag name in the modal
3. Click "Save"

### Editing a Tag

1. Click the edit button on a tag card
2. Modify tag name in the modal
3. Click "Save"

### Deleting a Tag

1. Click the delete button on a tag card
2. Confirm deletion in the dialog
3. Tag is permanently removed (bookmarks keep their tags, but tag association is removed)

## Empty State

![Tags Empty State](../assets/tags-empty-state.png)

When no tags exist:

- Displays tag icon
- Shows empty state message
- Displays "Create Tag" button
- Clean, centered layout

## Related Pages

- [Bookmarks](bookmarks) - View bookmarks filtered by tag
- [Folders](folders) - Folder management

## Technical Details

- **Component File**: `frontend/src/pages/Tags.tsx`
- **State Management**: React hooks (`useState`, `useEffect`)
- **Icon System**: Lucide React (Tag icon)
- **API Client**: Custom API client with interceptors
