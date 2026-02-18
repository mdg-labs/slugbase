---
id: folders
title: Folders Page
sidebar_position: 7
---

# Folders Page

## Overview

The Folders page allows users to organize their bookmarks using folders. Folders can be created, edited, deleted, and shared with teams. Each folder can have an optional icon for visual identification.

![Folders Overview](../assets/folders-overview.png)

## Route

- **Path**: `/folders` (self-hosted) or **`/app/folders`** (SlugBase Cloud)
- **Authentication**: Required
- **Access**: All authenticated users

## Features

### Folder Management

- **Create Folders**: Add new folders with name and optional icon
- **Edit Folders**: Modify folder name, icon, and sharing settings
- **Delete Folders**: Remove folders (with confirmation)
- **View Folders**: Display all folders in a responsive grid

### Folder Icons

- **Icon Selection**: Choose from Lucide icons or search for specific icons
- **Custom Icons**: Type any Lucide icon name
- **Popular Icons**: Quick selection of commonly used icons
- **No Icon**: Option to create folder without icon

### Sharing

- **Share with Teams**: Share folders with one or more teams
- **Team Members Access**: All team members can see shared folders
- **Shared Indicator**: Visual badge showing shared status

### Folder Cards

Each folder card displays:

1. **Header Section**
   - Folder icon (or default icon) in gradient background
   - Folder name (truncated if too long)
   - "Shared" badge if folder is shared with the user

2. **Shared Teams** (if applicable)
   - Team badges (up to 2 shown with "+N" indicator)
   - Team icons and names

3. **Actions** (own folders only)
   - **Edit Button**: Opens edit modal
   - **Delete Button**: Deletes folder (with confirmation)

### Card Design

- Modern rounded cards with hover effects
- Blue gradient icon backgrounds
- Consistent spacing and typography
- Dark/light mode support
- Responsive grid layout (1-4 columns based on screen size)

## User Interactions

### Creating a Folder

![Create Folder Modal](../assets/folder-modal-create.png)

1. Click "Create Folder" button
2. Fill in the folder modal:
   - Folder name (required)
   - Icon (optional - search or select from popular icons)
   - Share with teams (optional)
3. Click "Save"

![Folder Icon Picker](../assets/folder-modal-icon-picker.png)

### Editing a Folder

1. Click the edit button on a folder card (own folders only)
2. Modify fields in the modal:
   - Change name
   - Change icon
   - Update team sharing
3. Click "Save"

### Deleting a Folder

1. Click the delete button on a folder card (own folders only)
2. Confirm deletion in the dialog
3. Folder is permanently removed (bookmarks are not deleted)

### Viewing Shared Folders

- Shared folders are indicated with a green "Shared" badge
- Shared folders show team indicators
- Users can view but not edit shared folders (unless owner)

## Empty State

![Folders Empty State](../assets/folders-empty-state.png)

When no folders exist:

- Displays folder icon
- Shows empty state message
- Displays "Create Folder" button
- Clean, centered layout

## Related Pages

- [Bookmarks](bookmarks) - View bookmarks filtered by folder
- [Shared](shared) - View shared folders

## Technical Details

- **Component File**: `frontend/src/pages/Folders.tsx`
- **State Management**: React hooks (`useState`, `useEffect`)
- **Icon System**: Lucide React icons
- **API Client**: Custom API client with interceptors
