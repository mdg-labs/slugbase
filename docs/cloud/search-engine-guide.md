---
id: search-engine-guide
title: Search Engine Guide
sidebar_position: 13
---

# Search Engine Guide Page

## Overview

The Search Engine Guide page provides comprehensive instructions for setting up SlugBase as a custom search engine in various web browsers. This enables you to quickly access your bookmarks directly from the browser's address bar using a custom keyword and slug combination.

![Search Engine Guide Overview](../assets/search-engine-guide-overview.png)

## Route

- **Path**: `/search-engine-guide` (self-hosted) or **`/app/search-engine-guide`** (SlugBase Cloud)
- **Authentication**: Required
- **Access**: All authenticated users

## Features

### Browser-Specific Instructions

The guide provides step-by-step instructions for:

1. **Chromium-based Browsers** (Chrome, Edge, Brave, etc.)
2. **Firefox**

### Key Information Displayed

- **How It Works**: Explanation of the search engine concept
- **Your Search URL**: Personalized search URL template (on Cloud, uses the app URL e.g. `https://app.slugbase.app/app/go/%s`)
- **Step-by-Step Instructions**: Detailed setup steps per browser
- **Usage Example**: Practical example of using the search engine

## User Interface

### Header Section

- **Back Button**: Returns to bookmarks page
- **Title**: "Custom Search Engine Setup Guide"
- **Description**: Brief explanation of the feature

### Content Sections

1. **How It Works** – Explanation and example: `go your-slug`
2. **Your Search URL** – URL template with `%s` placeholder (Cloud: includes `/app/go/%s`)
3. **Chromium-based Browsers** – Step-by-step setup
4. **Firefox** – Step-by-step setup
5. **Usage Example** – Example: `go test`

## User Interactions

### Navigating to Guide

1. From Bookmarks page, click "Learn how to set up a custom search engine" link
2. Or navigate directly to `/app/search-engine-guide` (Cloud) or `/search-engine-guide` (self-hosted)
3. Guide loads with the correct search URL for your environment

### Setting Up Search Engine

1. Read "How It Works" section
2. Copy the search URL shown
3. Follow browser-specific instructions to add a custom search engine with:
   - Name: SlugBase (or preferred name)
   - Keyword: go (or preferred keyword)
   - URL: The provided search URL
4. Test by typing `go {slug}` in the address bar

## How It Works

1. You type keyword + slug in the address bar (e.g., `go mylink`)
2. Browser navigates to your SlugBase app at `/app/go/mylink` (Cloud) or `/go/mylink` (self-hosted)
3. SlugBase looks up the bookmark by slug (you must be logged in)
4. If found and forwarding is enabled, you are redirected to the bookmark URL

## Related Pages

- [Bookmarks](bookmarks) - Create bookmarks with slugs and enable forwarding
- [Profile](profile) - Account settings and link to Go preferences
