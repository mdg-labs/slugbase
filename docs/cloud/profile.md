---
id: profile
title: Profile Page
sidebar_position: 10
---

# Profile Page

## Overview

The Profile page allows users to view and manage their account settings, including email, name, user key, language preference, and theme selection. It provides an inline editing interface for quick updates.

![Profile Overview](../assets/profile-overview.png)

## Route

- **Path**: `/profile` (self-hosted) or **`/app/profile`** (SlugBase Cloud)
- **Authentication**: Required
- **Access**: All authenticated users

## Features

### User Information Management

#### Email
- **View**: Display current email address
- **Edit**: Click edit button to modify email
- **Validation**: Email format validation on save
- **Inline Editing**: Edit in-place without navigating away

#### Name
- **View**: Display current name
- **Edit**: Click edit button to modify name
- **Inline Editing**: Edit in-place without navigating away

#### User Key
- **Display**: Shows unique user key (read-only)
- **Copy**: One-click copy to clipboard
- **Visual Feedback**: Checkmark appears after successful copy
- **Tooltip**: Copy button tooltip for clarity

### Settings

#### Language Selection
- **Options**: English, German, French
- **Immediate Effect**: Language changes apply immediately
- **Persistence**: Saved to user profile
- **Dropdown**: Select component for easy selection

#### Theme Selection
- **Options**: Auto, Light, Dark
- **Auto Mode**: Follows system/browser preference
- **Manual Override**: Force light or dark mode
- **Persistence**: Saved to user profile
- **Immediate Effect**: Theme changes apply immediately

#### AI Suggestions
- **Toggle**: Enable or disable AI suggestions when creating bookmarks
- **Visibility**: Only shown when AI is enabled for your organization (Personal, Team, or Early Supporter plans)
- **Persistence**: Saved to user profile
- **Effect**: When disabled, no AI suggestions appear in the bookmark creation modal

### Cloud: Organization switcher

On SlugBase Cloud, if you belong to more than one organization, the Profile page shows an **Organization** section. Use it to switch the active organization. Your bookmarks, folders, and teams are scoped to the selected organization. Changing organization updates the context for the rest of the app until you switch again.

### Go preferences

From Profile you can open **Go preferences** (path: `/app/go-preferences` on Cloud, `/go-preferences` when self-hosted) to manage default slug behavior and view the [Search Engine Guide](search-engine-guide) for browser keyword setup.

## User Interactions

### Editing Email

1. Click "Edit" button next to email
2. Input field appears inline
3. Modify email address
4. Click "Save" or "Cancel"
5. On Cloud, email changes may require verification; a verification email is sent

### Editing Name

1. Click "Edit" button next to name
2. Input field appears inline
3. Modify name
4. Click "Save" or "Cancel"

### Copying User Key

1. Click copy button next to user key
2. User key is copied to clipboard
3. Checkmark icon appears temporarily

### Changing Language or Theme

1. Select language or theme from dropdown
2. Optionally change other settings
3. Click "Save Settings" button
4. Changes apply immediately

### Toggling AI Suggestions (Cloud)

1. When your plan includes AI and it is enabled for the organization, the AI Suggestions toggle appears in Preferences
2. Toggle on or off
3. Click "Save Settings" button

### Switching Organization (Cloud)

1. In the Organization section, select a different organization from the dropdown
2. The app reloads in the context of the selected organization

## Related Pages

- [Login and Auth](auth) - How to sign in to SlugBase Cloud
- [Admin](admin) - Organization and billing management (admins/owners)
- [Password Reset](password-reset) - Recovering your password
- [Search Engine Guide](search-engine-guide) - Browser custom search setup

## Technical Details

- **Component File**: `frontend/src/pages/Profile.tsx`
- **State Management**: React hooks (`useState`, `useEffect`)
- **API Integration**: Via AuthContext and `PUT /users/me`, `GET /organizations`, `PUT /organizations/me/switch` (Cloud)
