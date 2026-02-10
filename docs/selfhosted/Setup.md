---
id: setup
title: Setup Page
sidebar_position: 3
---

# Setup Page

## Overview

The Setup page is the initial configuration page displayed when SlugBase is first installed and no users exist in the system. It allows creating the first admin user, which then enables the rest of the application functionality. After setup is completed, this page becomes permanently inaccessible.

![Setup Form](../assets/setup-form.png)

## Route

- **Path**: `/setup`
- **Authentication**: Not required (public access)
- **Availability**: Only accessible when system is not initialized
- **Auto-redirect**: Initialized systems redirect away from setup page

## Features

### Initial Admin User Creation

- **Admin Creation**: First user automatically becomes administrator
- **Required Fields**: Email, name, and password
- **Password Validation**: Minimum 8 characters
- **Password Confirmation**: Must match password field
- **Form Validation**: Client-side and server-side validation

### Setup Flow

1. **Check Initialization Status**: System checks if users exist
2. **Display Setup Form**: If not initialized, show setup form
3. **Create Admin User**: Submit creates first user with admin privileges
4. **Success State**: Shows success message and redirects to login
5. **System Lock**: Setup page permanently disabled after first user creation

### Form Fields

1. **Email** (required)
   - Email format validation
   - Must be unique (system-wide)
   - Placeholder: "admin@example.com"

2. **Name** (required)
   - User's display name
   - Placeholder: "Admin User"

3. **Password** (required)
   - Minimum 8 characters
   - Secure password input (hidden)
   - Placeholder: "Minimum 8 characters"

4. **Confirm Password** (required)
   - Must match password
   - Client-side validation
   - Placeholder: "Re-enter your password"

## User Interface

### Layout

- **Centered Form**: Clean, centered setup form
- **Card Design**: White/dark card with rounded corners and shadow
- **Hero Section**: Icon, title, and description
- **Admin Notice**: Informational banner about admin privileges
- **Success State**: Success message with redirect notice

### Visual Elements

1. **Header Icon**: UserPlus icon in blue circle
2. **Title**: "Initial Setup"
3. **Description**: Welcome message and instructions
4. **Admin Notice**: Blue info box explaining admin privileges
5. **Form Fields**: Labeled input fields with validation
6. **Submit Button**: Primary action button

### Success State

![Setup Success](../assets/setup-success.png)

After successful setup:
- **Success Icon**: CheckCircle icon in green circle
- **Success Message**: "Setup completed successfully!"
- **Redirect Notice**: "Redirecting to login..."
- **Auto-redirect**: Automatic redirect to login page after 2 seconds

## User Interactions

### Completing Setup

1. Navigate to application (if not initialized, automatically shown setup)
2. Fill in email address
3. Fill in name
4. Enter password (minimum 8 characters)
5. Confirm password (must match)
6. Review admin notice
7. Click "Create Admin User" button
8. Wait for success message
9. Automatically redirected to login page

### Form Validation

- **Real-time Validation**: Client-side validation on blur
- **Submit Validation**: Server-side validation on submit
- **Error Messages**: Clear, specific error messages
- **Field Highlighting**: Error states highlight problematic fields

## Component Structure

```tsx
<Setup>
  <Container>
    <Header>
      <Icon>
      <Title>
      <Description>
    </Header>
    {success ? (
      <Success State>
        <Icon>
        <Message>
        <Redirect Notice>
      </Success>
    ) : (
      <Setup Card>
        <Form>
          <Email Input>
          <Name Input>
          <Password Input>
          <Confirm Password Input>
          <Admin Notice>
          <Error Display>
          <Submit Button>
        </Form>
      </Card>
    )}
  </Container>
</Setup>
```

## API Integration

- `GET /auth/setup/status` - Check if system is initialized
- `POST /auth/setup` - Create first admin user

### Setup Endpoint

**POST /auth/setup**
- **Body**: `{ email, name, password }`
- **Response**: Success or error
- **Side Effect**: Creates first user with `is_admin: true`
- **System State**: Marks system as initialized

## Security Considerations

### Password Security

- **Minimum Length**: 8 characters required
- **Password Hashing**: Passwords hashed with bcrypt
- **No Plaintext Storage**: Passwords never stored in plain text
- **Secure Transmission**: HTTPS recommended in production

### Setup Protection

- **One-Time Setup**: Setup only works once
- **Permanent Lock**: After first user, setup permanently disabled
- **Admin Creation**: First user always becomes admin
- **No Bypass**: No way to re-enable setup after initialization

### Validation

- **Email Uniqueness**: Server validates unique email
- **Password Strength**: Minimum length enforcement
- **Input Sanitization**: Server-side validation
- **Error Messages**: Generic errors prevent enumeration

## Error Handling

### Validation Errors

- **Password Mismatch**: "Passwords do not match"
- **Password Too Short**: "Password must be at least 8 characters long"
- **Email Format**: Email format validation
- **Server Errors**: Generic error message on failure

### Network Errors

- **Connection Issues**: Connection error messages
- **Timeout Handling**: Request timeout handling
- **Retry Logic**: User can retry submission

## State Management

### Form State

- **Form Data**: `{ email, name, password, confirmPassword }`
- **Loading**: Button disabled during submission
- **Error**: Error message state
- **Success**: Success state triggers redirect

### Initialization Check

- **Setup Status**: Fetched on mount
- **Auto-redirect**: Redirects if already initialized
- **Loading State**: Shows loading while checking

## Styling

- **Clean Design**: Professional, welcoming interface
- **Dark Mode**: Full dark/light mode support
- **Responsive**: Mobile-friendly layout
- **Visual Hierarchy**: Clear information architecture
- **Success Feedback**: Clear success indicators

## Related Components

- `Button` - Styled button component
- Form inputs - Standard HTML inputs with styling

## Related Pages

- [Login](login) - Post-setup authentication
- [Admin](admin) - Admin panel (accessible after login as first user)

## Technical Details

- **Component File**: `frontend/src/pages/Setup.tsx`
- **State Management**: React hooks (`useState`)
- **Routing**: React Router (conditional rendering)
- **API Client**: Custom API client
- **Validation**: Client-side and server-side

## i18n Keys Used

- `setup.*` - All setup-related strings
- `common.loading` - Loading state text
- `common.error` - Error messages

## Initialization Flow

1. **App Start**: Check setup status
2. **Not Initialized**: Show setup page
3. **Initialized**: Show login page
4. **After Setup**: Redirect to login
5. **System Lock**: Setup never accessible again

## Admin Notice

The setup form includes a prominent notice explaining:
- First user becomes administrator
- OIDC providers can be configured later
- Admin panel accessible after login
- Important for security awareness

## Best Practices

1. **Secure Password**: Use strong password for admin account
2. **Valid Email**: Use real email for password recovery
3. **Documentation**: Note admin credentials securely
4. **OIDC Setup**: Configure OIDC providers after setup
5. **Backup**: Consider backing up admin account details

## User Experience

1. **Clear Instructions**: Obvious what to do
2. **Validation Feedback**: Immediate validation feedback
3. **Success Confirmation**: Clear success state
4. **Auto-redirect**: Seamless transition to login
5. **Professional Design**: Builds confidence in application

## Accessibility

- Proper form labels
- Keyboard navigation
- Screen reader support
- Focus management
- ARIA attributes
