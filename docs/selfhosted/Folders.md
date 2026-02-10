---
id: folders
title: Folders Page
sidebar_position: 6
---

# Folders Page

## Overview

The Folders page allows users to organize their bookmarks using folders. Folders can be created, edited, deleted, and shared with teams. Each folder can have an optional icon for visual identification.

![Folders Overview](../assets/folders-overview.png)

## Route

- **Path**: `/folders`
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

## Component Structure

```tsx
<Folders>
  <Header>
    <Title>
    <Count>
    <Create Button>
  </Header>
  <Folders Grid>
    <Folder Card>
      <Icon>
      <Name & Badges>
      <Shared Teams>
      <Actions>
    </Card>
  </Grid>
  <Folder Modal>
  <Confirm Dialog>
</Folders>
```

## API Integration

- `GET /folders` - Fetch all folders
- `GET /teams` - Fetch teams for sharing
- `POST /folders` - Create new folder
- `PUT /folders/:id` - Update folder
- `DELETE /folders/:id` - Delete folder

## Folder Icons

Folders support icons from the Lucide icon library:
- Icons are displayed in a searchable modal
- Popular icons are pre-selected for quick access
- Users can type any icon name to use custom icons
- Icons are stored as string identifiers (e.g., "folder", "book", "star")

## Bookmark Association

- Folders are associated with bookmarks through a many-to-many relationship
- A bookmark can belong to multiple folders
- Deleting a folder does not delete associated bookmarks
- Bookmarks are shown on the [Bookmarks](bookmarks) page with folder badges

## Styling

- Modern card design with rounded corners (`rounded-xl`)
- Blue gradient icon backgrounds
- Hover effects with border color change and shadow
- Consistent badge styling with borders
- Responsive grid: `grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4`
- Spacing: `gap-4`, padding: `p-5`

## Related Components

- `FolderModal` - Create/edit folder form with icon picker
- `FolderIcon` - Displays folder icons (handles missing icons gracefully)
- `ConfirmDialog` - Deletion confirmation

## Related Pages

- [Bookmarks](bookmarks) - View bookmarks filtered by folder
- [Shared](shared) - View shared folders

## Technical Details

- **Component File**: `frontend/src/pages/Folders.tsx`
- **State Management**: React hooks (`useState`, `useEffect`)
- **Icon System**: Lucide React icons
- **API Client**: Custom API client with interceptors

## i18n Keys Used

- `folders.*` - All folder-related strings
- `common.*` - Common UI strings (loading, edit, delete, etc.)

## Performance Considerations

- Folders are loaded on component mount
- Icon rendering is optimized with caching
- Grid layout optimizes for different screen sizes
- Efficient re-renders with React hooks
