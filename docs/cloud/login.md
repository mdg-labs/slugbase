---
id: login
title: Login Page
sidebar_position: 11
---

# Login Page

## Overview

The Login page is the entry point for signing in to SlugBase Cloud. It supports email/password and OIDC providers (Google, Microsoft, GitHub). Authenticated users are redirected to the app dashboard.

![Login Page - Local Auth Only](../assets/login-local-only.png)

![Login Page with OIDC Providers](../assets/login-with-oidc.png)

## Route

- **Path**: **`/app/login`** (SlugBase Cloud)
- **Authentication**: Not required (public access)
- **Redirect**: Authenticated users are redirected to the app dashboard (`/app`)

## Sign up

If you don't have an account, use **Sign up** at **`/app/signup`** to create one with email verification. You can also sign in with Google, Microsoft, or GitHub if those providers are offered on the login page.

## Features

### Local Authentication (Email/Password)

- **Email/Password Login**: Sign in with the email and password you used when signing up
- **Form Validation**: Email format and required field validation
- **Error Handling**: User-friendly error messages
- **Password Visibility**: Secure password input with optional show/hide

### OIDC Authentication

On SlugBase Cloud, you can sign in with:

- **Google** – Sign in with your Google account
- **Microsoft** – Sign in with a Microsoft or work/school account
- **GitHub** – Sign in with your GitHub account

Provider buttons are shown on the login page when available. Click a button to be redirected to that provider; after you approve, you are brought back to SlugBase and logged in.

For more details on providers and session behavior, see [Login and Auth Providers](auth).

### Password Recovery

- **Forgot Password Link**: Opens the [Password Reset](password-reset) flow
- Reset links are sent by email (on Cloud, via Postmark)

## User Interactions

### Local Login

1. Enter email address
2. Enter password
3. Click "Login" button
4. On success: Redirected to app dashboard
5. On error: Error message displayed

### OIDC Login

1. Click provider button (e.g., "Login with Google")
2. Redirected to the provider
3. Authenticate with the provider
4. Redirected back to SlugBase Cloud
5. Session established, redirected to app dashboard

### Password Recovery

1. Click "Forgot password?" link
2. You are taken to the [Password Reset](password-reset) page

## Related Pages

- [Login and Auth Providers](auth) – Supported providers and how sessions work
- [Password Reset](password-reset) – Recover your password
- [Dashboard](dashboard) – Post-login landing page
