---
id: admin
title: Admin Page
sidebar_position: 13
---

# Admin Page

## Overview

The Admin page provides administrative controls for managing users, teams, OIDC providers, and system settings. It's accessible only to users with admin privileges and features a tabbed interface for organizing different administrative functions.

![Admin Page Overview](../assets/admin-overview.png)

## Route

- **Path**: `/admin` (redirects to `/admin/members`)
- **Tab paths**: `/admin/members`, `/admin/teams`, `/admin/oidc`, `/admin/settings`, `/admin/ai`
- **Authentication**: Required
- **Authorization**: Admin users only
- **Access**: Redirects to dashboard if user is not admin

## Features

### Tabbed Interface

The admin page uses a tabbed navigation system with five main sections:

1. **Users Tab** (`/admin/members`) – Manage system users
2. **Teams Tab** (`/admin/teams`) – Manage teams and team memberships
3. **OIDC Providers Tab** (`/admin/oidc`) – Configure OIDC authentication providers
4. **Settings Tab** (`/admin/settings`) – System-wide settings (e.g., SMTP configuration)
5. **AI Suggestions Tab** (`/admin/ai`) – Configure AI-powered bookmark suggestions

### Users Management

![Admin Users Tab](../assets/admin-users-tab.png)

Comprehensive user management including:

- **View Users**: List all users in the system
- **Create Users**: Add new users manually
- **Edit Users**: Modify user details (name, email, role)
- **Delete Users**: Remove users from the system
- **Manage Teams**: Assign users to teams
- **Role Management**: Set user roles (admin/user)

![Admin User Modal](../assets/admin-user-modal.png)

#### User Operations:
- Create new users with email/password
- Edit user information
- Delete users (with confirmation)
- Manage team memberships per user
- View user details

### Teams Management

![Admin Teams Tab](../assets/admin-teams-tab.png)

Team-based organization features:

- **View Teams**: List all teams
- **Create Teams**: Add new teams
- **Edit Teams**: Modify team details
- **Delete Teams**: Remove teams (with confirmation)
- **Manage Members**: Add/remove users from teams
- **Team Descriptions**: Optional team descriptions

![Admin Team Modal](../assets/admin-team-modal.png)

#### Team Operations:
- Create new teams
- Edit team information
- Delete teams
- Add/remove team members
- Search teams by name/description

### OIDC Providers Management

![Admin OIDC Providers Tab](../assets/admin-oidc-tab.png)

Authentication provider configuration:

- **View Providers**: List configured OIDC providers
- **Add Providers**: Configure new OIDC providers
- **Edit Providers**: Modify provider settings
- **Delete Providers**: Remove providers (with confirmation)
- **Provider Settings**:
  - Provider key (unique identifier)
  - Client ID
  - Client Secret (encrypted storage)
  - Issuer URL
  - Scopes
  - Auto-create users option
  - Default role for new users

![Admin OIDC Provider Modal](../assets/admin-oidc-modal.png)

#### Provider Configuration:
- Support for multiple OIDC providers
- Secure secret storage (encrypted)
- Auto-user creation on first login
- Default role assignment
- Provider testing capabilities

### Settings Management

![Admin Settings Tab](../assets/admin-settings-tab.png)

System-wide configuration:

- **SMTP Configuration**: Email server settings for password resets
- **System Settings**: Key-value configuration pairs
- **Settings Include**:
  - SMTP enabled/disabled
  - SMTP host, port, security
  - SMTP credentials
  - From email/name
  - Test email functionality

#### Settings Operations:
- Configure SMTP for email functionality
- Test email configuration
- Manage system settings
- View/edit key-value pairs

### AI Suggestions Management

Optional AI-powered suggestions for title, tags, and slug when creating bookmarks:

- **Enable/Disable**: Toggle AI suggestions on or off for the instance
- **Provider**: AI provider (default: OpenAI)
- **API Key**: OpenAI API key (masked in UI, encrypted at rest)
- **Model**: Model name (default: gpt-4o-mini)

When not configured, the feature is disabled and bookmark creation works normally. Users can disable AI suggestions in their profile even when enabled by admin.

#### AI Configuration:
- API key stored encrypted (same pattern as OIDC secrets)
- Leave API key blank to keep existing key when updating other settings
- Get API key from [platform.openai.com](https://platform.openai.com)

## User Interactions

### Accessing Admin Panel

1. User must be authenticated
2. User must have `is_admin: true`
3. Navigate to `/admin` (or directly to `/admin/members`); the default redirect goes to the Users (members) tab
4. Non-admin users are redirected to dashboard

### Managing Users

1. Click "Users" tab (path: `/admin/members`)
2. View list of all users
3. Click "Add User" to create new user
4. Click edit icon to modify user
5. Click delete icon to remove user (with confirmation)
6. Click "Manage Teams" to assign teams to user

### Managing Teams

1. Click "Teams" tab
2. View list of all teams
3. Click "Add Team" to create new team
4. Click edit icon to modify team
5. Click delete icon to remove team (with confirmation)
6. Click "Manage Members" to add/remove users

### Managing OIDC Providers

1. Click "OIDC Providers" tab
2. View list of configured providers
3. Click "Add Provider" to configure new provider
4. Fill in provider details (key, client ID, secret, issuer, scopes)
5. Set auto-create and default role options
6. Save provider configuration

### Managing Settings

1. Click "Settings" tab
2. Configure SMTP settings (optional, for password resets)
3. Test email configuration
4. Manage system settings key-value pairs

### Managing AI Settings

1. Click "AI Suggestions" tab
2. Toggle "Enable AI suggestions" on or off
3. Enter OpenAI API key (get from platform.openai.com)
4. Optionally set model (default: gpt-4o-mini)
5. Click "Save"

## Component Structure

```tsx
<Admin>
  <Header>
    <Title>
    <Description>
  </Header>
  <Tabs>
    <Users Tab>
    <Teams Tab>
    <OIDC Tab>
    <Settings Tab>
    <AI Tab>
  </Tabs>
  <Tab Content>
    {activeTab === 'users' && <AdminUsers />}
    {activeTab === 'teams' && <AdminTeams />}
    {activeTab === 'oidc' && <AdminOIDCProviders />}
    {activeTab === 'settings' && <AdminSettings />}
    {activeTab === 'ai' && <AdminAI />}
  </Tab Content>
  <API Docs Link>
</Admin>
```

## Sub-Components

### AdminUsers
- User list with search
- User creation/edit modals
- Team management modal
- User deletion with confirmation

### AdminTeams
- Team list with search
- Team creation/edit modals
- Member management modal
- Team deletion with confirmation

### AdminOIDCProviders
- Provider list
- Provider creation/edit modal
- Provider deletion with confirmation
- Secure secret handling

### AdminSettings
- SMTP configuration form
- Test email functionality
- System settings key-value editor

### AdminAI
- AI enable/disable toggle
- Provider and model configuration
- API key input (masked when set)

## API Integration

### Users
- `GET /admin/users` - List all users
- `POST /admin/users` - Create user
- `PUT /admin/users/:id` - Update user
- `DELETE /admin/users/:id` - Delete user
- `GET /admin/users/:id/teams` - Get user teams
- `PUT /admin/users/:id/teams` - Update user teams

### Teams
- `GET /admin/teams` - List all teams
- `POST /admin/teams` - Create team
- `PUT /admin/teams/:id` - Update team
- `DELETE /admin/teams/:id` - Delete team
- `GET /admin/teams/:id/members` - Get team members
- `PUT /admin/teams/:id/members` - Update team members

### OIDC Providers
- `GET /admin/oidc-providers` - List providers
- `POST /admin/oidc-providers` - Create provider
- `PUT /admin/oidc-providers/:id` - Update provider
- `DELETE /admin/oidc-providers/:id` - Delete provider

### Settings
- `GET /admin/settings` - Get settings
- `POST /admin/settings` - Create/update setting
- `DELETE /admin/settings/:key` - Delete setting
- `POST /admin/settings/smtp` - Save SMTP config
- `POST /admin/settings/smtp/test` - Test SMTP

### AI Settings
- `GET /admin/settings/ai` - Get AI config (API key masked)
- `POST /admin/settings/ai` - Save AI config (encrypts API key)

## Security Considerations

### Access Control
- Route-level protection (redirects non-admins)
- Component-level checks
- API-level authorization (backend validates admin status)

### Data Protection
- OIDC secrets encrypted at rest
- Password hashing (never stored in plain text)
- Secure session management
- CSRF protection

### Audit Trail
- User actions logged (where applicable)
- Deletion confirmations required
- Sensitive operations require admin privileges

## Related Pages

- [Login](login) - User authentication
- [Profile](profile) - User profile management
- [Setup](setup) - Initial system setup

## Technical Details

- **Component File**: `frontend/src/pages/Admin.tsx`
- **Sub-Components**: Located in `frontend/src/components/admin/`
- **State Management**: React hooks (`useState`)
- **Tab Management**: Local state for active tab
- **Authorization**: Protected route component

## i18n Keys Used

- `admin.*` - All admin-related strings
- `common.*` - Common UI strings

## API Documentation Link

At the bottom of the admin page, a link to API documentation is provided:
- Opens in new tab
- Interactive Swagger/OpenAPI interface
- Complete API reference

## Best Practices

1. **User Management**:
   - Verify user information before deletion
   - Use confirmations for destructive actions
   - Maintain audit logs

2. **Team Management**:
   - Consider impact of team deletion on sharing
   - Verify team memberships before changes
   - Use descriptive team names

3. **OIDC Providers**:
   - Test provider configuration before saving
   - Keep secrets secure (encrypted storage)
   - Document provider keys for reference

4. **Settings**:
   - Test SMTP configuration before production use
   - Backup settings before changes
   - Document custom settings keys

5. **AI Suggestions**:
   - Store API key securely (encrypted at rest)
   - Feature is optional; bookmark creation never depends on AI
   - Users can opt out in profile even when enabled

## Error Handling

- Network errors display user-friendly messages
- Validation errors shown inline
- Server errors logged and displayed
- Confirmation dialogs prevent accidental actions

## Performance Considerations

- Lazy loading of admin sub-components
- Efficient tab switching
- Search/filter functionality for large lists
- Pagination where applicable (future enhancement)
