---
id: dashboard
title: Dashboard Page
sidebar_position: 5
---

# Dashboard Page

## Overview

The Dashboard is the main landing page of SlugBase, displayed when users navigate to the root path (`/`) after authentication. It provides an overview of the application's main features and quick navigation to core sections.

![Dashboard Overview](../assets/dashboard-overview.png)

## Route

- **Path**: **`/app`** (SlugBase Cloud; root of the app after login)
- **Authentication**: Required
- **Access**: All authenticated users

## Features

### Dashboard stats

The dashboard fetches summary data from **`GET /api/dashboard/stats`** and displays:

- **Your library**: Total bookmarks, total folders, total tags (each links to the corresponding section). On SlugBase Cloud, the bookmarks stat shows usage against your plan limit (e.g. "X / Y bookmarks") when a limit applies.
- **Shared with you**: Count of shared bookmarks and shared folders (links to the Shared page).

Stats are shown in compact cards with icons; clicking a card navigates to the relevant page.

### Recent bookmarks

A **Recent bookmarks** card lists recently added or accessed bookmarks. For each item you can open, edit, copy URL, delete, or share. If there are no recent bookmarks, the card shows an empty state with a link to create a bookmark or to upgrade when at plan limit.

### Top tags

A **Top tags** card shows your most-used tags (by bookmark count). Each tag links to the bookmarks page filtered by that tag.

### Density toggle

A **Dense view** toggle in the header reduces spacing and font size. The preference is stored in localStorage.

### Plan and upgrade (Cloud)

When you are on a plan with a bookmark limit and have reached it (or are on the Free plan and see limit messaging), the dashboard shows an **Upgrade** call-to-action that links to **Admin → Billing** where you can change plan or manage your subscription.

### Navigation Cards

![Dashboard Statistics](../assets/dashboard-stats.png)

Below the stats and recent content, the dashboard displays three main navigation cards:

1. **Bookmarks Card** (Blue) – Navigates to `/app/bookmarks`
2. **Folders Card** (Green) – Navigates to `/app/folders`
3. **Tags Card** (Purple) – Navigates to `/app/tags`

### Design Features

- **Page header**: Title, subtitle, dense toggle, quick links (create folder, create tag), and primary action (Create bookmark or Upgrade)
- **Card Layout**: Responsive grid for stats and content
- **Hover Effects**: Cards have shadow and transition effects on hover
- **Color Coding**: Each section uses a distinct color scheme
- **Internationalization**: All text is translatable via i18n

## User Interactions

1. **Stats cards**: Click to navigate to bookmarks, folders, tags, or shared.
2. **Recent bookmarks**: Open, edit, copy URL, delete, or share from the card.
3. **Top tags**: Click a tag to open bookmarks filtered by that tag.
4. **Dense view**: Toggle for compact layout.
5. **Navigation cards**: Click to go to bookmarks, folders, or tags.
6. **Upgrade (when at limit)**: Opens Admin → Billing to change plan.

## Styling

- Uses Tailwind CSS utility classes
- Supports dark/light mode via CSS variables
- Smooth transitions for interactive elements
- Color-coded cards for quick visual identification

## Related Pages

- [Bookmarks](bookmarks) - Main bookmark management
- [Folders](folders) - Folder organization
- [Tags](tags) - Tag management
- [Shared](shared) - Shared bookmarks and folders
- [Admin](admin) - Billing and plan (when at bookmark limit)

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
