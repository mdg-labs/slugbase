---
id: dashboard
title: Dashboard Page
sidebar_position: 4
---

# Dashboard Page

## Overview

The Dashboard is the main landing page of SlugBase, displayed when users navigate to the root path (`/`) after authentication. It provides an overview of the application's main features and quick navigation to core sections.

![Dashboard Overview](../assets/dashboard-overview.png)

## Route

- **Path**: `/`
- **Authentication**: Required
- **Access**: All authenticated users

## Features

### Navigation Cards

![Dashboard Statistics](../assets/dashboard-stats.png)

The dashboard displays three main navigation cards:

1. **Bookmarks Card** (Blue)
   - Navigates to `/bookmarks`
   - Description: "Manage your bookmarks"
   - Icon: Bookmark icon

2. **Folders Card** (Green)
   - Navigates to `/folders`
   - Description: "Organize with folders"
   - Icon: Folder icon

3. **Tags Card** (Purple)
   - Navigates to `/tags`
   - Description: "Tag your bookmarks"
   - Icon: Tag icon

### Design Features

- **Hero Section**: Displays app name ("SlugBase") and tagline
- **Card Layout**: Responsive grid (1 column mobile, 2 columns tablet, 3 columns desktop)
- **Hover Effects**: Cards have shadow and transition effects on hover
- **Color Coding**: Each card uses a distinct color scheme for visual differentiation
- **Internationalization**: All text is translatable via i18n

## Component Structure

```tsx
<Dashboard>
  <Hero Section>
    <App Name>
    <Tagline>
  </Hero>
  <Navigation Cards Grid>
    <Bookmark Card>
    <Folder Card>
    <Tag Card>
  </Grid>
</Dashboard>
```

## User Interactions

1. **Click on Card**: Navigates to the respective section
2. **Hover**: Visual feedback with shadow elevation
3. **Responsive**: Cards rearrange based on screen size

## Styling

- Uses Tailwind CSS utility classes
- Supports dark/light mode via CSS variables
- Smooth transitions for interactive elements
- Color-coded cards for quick visual identification

## Related Pages

- [Bookmarks](bookmarks) - Main bookmark management
- [Folders](folders) - Folder organization
- [Tags](tags) - Tag management

## Technical Details

- **Component File**: `frontend/src/pages/Dashboard.tsx`
- **Dependencies**: React Router (`Link`), React i18next (`useTranslation`)
- **Icons**: Lucide React (`Bookmark`, `Folder`, `Tag`, `ArrowRight`)
- **Layout**: Wrapped in main Layout component with navigation sidebar

## i18n Keys Used

- `app.name` - Application name
- `app.tagline` - Application tagline
- `bookmarks.title` - Bookmarks section title
- `folders.title` - Folders section title
- `tags.title` - Tags section title
- `dashboard.bookmarksDescription` - Bookmarks card description
- `dashboard.foldersDescription` - Folders card description
- `dashboard.tagsDescription` - Tags card description
- `common.view` - "View" button text
