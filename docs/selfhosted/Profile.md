---
id: profile
title: Profile Page
sidebar_position: 9
---

# Profile Page

## Overview

The Profile page allows users to view and manage their account settings, including email, name, user key, language preference, and theme selection. It provides an inline editing interface for quick updates.

![Profile Overview](../assets/profile-overview.png)

## Route

- **Path**: `/profile`
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

### Form Structure

The profile is organized into sections:

1. **Email Section** (Blue icon)
   - View/edit toggle
   - Inline editing form
   - Error handling

2. **Name Section** (Green icon)
   - View/edit toggle
   - Inline editing form
   - Error handling

3. **User Key Section** (Purple icon)
   - Read-only display
   - Copy functionality
   - Visual feedback

4. **Language Section** (Indigo icon)
   - Dropdown selection
   - Save with other settings

5. **Theme Section** (Pink icon)
   - Dropdown selection
   - Save with other settings

## User Interactions

### Editing Email

![Profile Email Edit Mode](../assets/profile-email-edit.png)

1. Click "Edit" button next to email
2. Input field appears inline
3. Modify email address
4. Click "Save" or "Cancel"
5. Error message appears if validation fails

![Email Verification Pending](../assets/profile-email-pending.png)

### Editing Name

1. Click "Edit" button next to name
2. Input field appears inline
3. Modify name
4. Click "Save" or "Cancel"
5. Error message appears if validation fails

### Copying User Key

1. Click copy button next to user key
2. User key is copied to clipboard
3. Checkmark icon appears temporarily
4. Toast notification may appear (depending on implementation)

### Changing Language

![Profile Preferences](../assets/profile-preferences.png)

1. Select language from dropdown
2. Optionally change other settings
3. Click "Save Settings" button
4. Language changes immediately

### Changing Theme

1. Select theme from dropdown
2. Optionally change other settings
3. Click "Save Settings" button
4. Theme changes immediately

## Component Structure

```tsx
<Profile>
  <Header>
    <Title>
    <Description>
  </Header>
  <Profile Card>
    <Email Section>
      <View Mode> | <Edit Mode>
    </Email>
    <Name Section>
      <View Mode> | <Edit Mode>
    </Name>
    <User Key Section>
      <Display>
      <Copy Button>
    </User Key>
    <Settings Form>
      <Language Select>
      <Theme Select>
      <Save Button>
    </Settings>
  </Card>
</Profile>
```

## API Integration

- `GET /users/me` - Fetch current user data (via AuthContext)
- `PUT /users/me` - Update user profile
- Updates include: `email`, `name`, `language`, `theme`

## Form State Management

### Editing States
- `editingEmail`: Boolean toggles email edit mode
- `editingName`: Boolean toggles name edit mode
- `formData`: Contains all form values
- `errors`: Object containing field-specific error messages

### Save Behavior
- Email and name can be saved individually (inline editing)
- Language and theme are saved together via form submit
- All changes trigger API calls
- Success/error handling for each operation

## Error Handling

### Email Errors
- Email format validation
- Duplicate email detection
- Server-side validation errors
- Displayed inline below input field

### Name Errors
- Required field validation
- Server-side validation errors
- Displayed inline below input field

### General Errors
- API error handling
- Network error handling
- User-friendly error messages

## Styling

- **Section Icons**: Color-coded icons for each section
- **Inline Editing**: Smooth transitions between view/edit modes
- **Form Layout**: Clean, organized sections with proper spacing
- **Dark/Light Mode**: Full theme support
- **Responsive**: Works on all screen sizes

## Related Components

- `Select` - Dropdown component for language/theme
- `Button` - Action buttons throughout
- `AuthContext` - Provides user data and update function

## Related Pages

- [Login](login) - User authentication
- [Admin](admin) - Admin user management

## Technical Details

- **Component File**: `frontend/src/pages/Profile.tsx`
- **State Management**: React hooks (`useState`, `useEffect`)
- **API Integration**: Via AuthContext `updateUser` function
- **Clipboard API**: Native `navigator.clipboard.writeText`
- **Form Handling**: Controlled components with React state

## i18n Keys Used

- `profile.*` - All profile-related strings
- `common.*` - Common UI strings (save, cancel, edit, etc.)
- `bookmarks.copied` - Copy success message
- `bookmarks.copyUrl` - Copy button tooltip

## Internationalization

The Profile page is fully internationalized:
- All UI text uses i18n keys
- Language selection changes interface language
- Language options themselves are translated

## Theme Management

Theme selection affects:
- Immediate visual changes
- Persistence across sessions
- Application-wide theme state
- CSS variable updates

## Performance Considerations

- Inline editing reduces page navigation
- Efficient re-renders with controlled components
- User data cached in AuthContext
- Optimistic UI updates where possible

## Security Notes

- User key is read-only (cannot be changed)
- Email changes may require verification (depending on backend)
- Password changes handled on separate [Password Reset](password-reset) page
- All updates require authentication

## User Experience Enhancements

1. **Inline Editing**: Quick edits without page reload
2. **Visual Feedback**: Copy confirmation, edit mode indicators
3. **Error Handling**: Clear error messages near relevant fields
4. **Cancel Option**: Easy way to discard changes
5. **Sectioned Layout**: Organized information hierarchy
6. **Color Coding**: Icons help identify sections quickly
