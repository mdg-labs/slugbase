---
id: password-reset
title: Password Reset Page
sidebar_position: 12
---

# Password Reset Page

## Overview

The Password Reset page provides a two-step password recovery flow for users who have forgotten their passwords. It handles both the password reset request (sending email) and the actual password reset (with token). The page automatically detects which step to show based on the presence of a reset token in the URL.

![Password Reset Request](../assets/password-reset-request.png)

## Route

- **Path**: `/password-reset` or `/reset-password` (self-hosted), or **`/app/password-reset`** / **`/app/reset-password`** (SlugBase Cloud)
- **Authentication**: Not required (public access)
- **Query Parameter**: `token` (optional, for reset step)

## Features

### Two-Step Flow

The page operates in two modes:

1. **Request Step** (default) - Request password reset email
2. **Reset Step** (with token) - Enter new password

### Step 1: Request Password Reset

- **Email Input**: User enters their email address
- **Email Sending**: Backend sends password reset email
- **Privacy Protection**: Always shows success message (prevents email enumeration)
- **SlugBase Cloud**: Email is sent via Postmark; no SMTP configuration in the app. Reset links point to the Cloud app (e.g. `https://app.slugbase.app/app/reset-password?token=...`).

### Step 2: Reset Password

![Password Reset Form](../assets/password-reset-form.png)

- **Token Verification**: Validates reset token from email link
- **Password Input**: New password field
- **Confirm Password**: Password confirmation field
- **Validation**: Password match validation
- **Success Redirect**: Redirects to login after successful reset

## User Interactions

### Requesting Password Reset

1. Navigate to the password reset page (or click "Forgot password?" on login)
2. Enter email address
3. Click "Send Reset Link"
4. Success message displayed (even if email doesn't exist - privacy)
5. Check email for reset link
6. Click reset link in email

### Resetting Password

1. Click reset link from email (contains token parameter)
2. Page loads with token
3. Token is verified automatically
4. If valid: Password form appears
5. If invalid: Error message and link to request new reset
6. Enter new password
7. Confirm password (must match)
8. Click "Reset Password"
9. On success: Redirected to login page after a short delay

## Related Pages

- [Login and Auth](auth) - Sign in to SlugBase Cloud
- [Login](login) - Login page (entry point and post-reset destination)
