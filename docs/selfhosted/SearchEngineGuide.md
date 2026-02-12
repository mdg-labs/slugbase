---
id: search-engine-guide
title: Search Engine Guide
sidebar_position: 12
---

# Search Engine Guide Page

## Overview

The Search Engine Guide page provides comprehensive instructions for setting up SlugBase as a custom search engine in various web browsers. This enables users to quickly access their bookmarks directly from the browser's address bar using a custom keyword and slug combination.

![Search Engine Guide Overview](../assets/search-engine-guide-overview.png)

## Route

- **Path**: `/search-engine-guide`
- **Authentication**: Required
- **Access**: All authenticated users

## Features

### Browser-Specific Instructions

The guide provides step-by-step instructions for:

1. **Chromium-based Browsers** (Chrome, Edge, Brave, etc.)
2. **Firefox**

### Key Information Displayed

- **How It Works**: Explanation of the search engine concept
- **Your Search URL**: Personalized search URL template for the current user
- **Step-by-Step Instructions**: Detailed setup steps per browser
- **Usage Example**: Practical example of using the search engine

## User Interface

### Header Section

- **Back Button**: Returns to bookmarks page
- **Title**: "Custom Search Engine Setup Guide"
- **Description**: Brief explanation of the feature

### Content Sections

1. **How It Works**
   - Blue info box
   - Explanation of the search engine concept
   - Visual example: `go your-slug`

2. **Your Search URL**
   - White card with code display
   - URL: `{BASE_URL}/go/%s` (or `{BASE_URL}/app/go/%s` in CLOUD mode)
   - Note about `%s` placeholder

3. **Chromium-based Browsers**
   - Green checkmark icon
   - Step-by-step instructions (5 steps)
   - Sub-steps for form fields

4. **Firefox**
   - Orange checkmark icon
   - Step-by-step instructions (5 steps)
   - Sub-steps for form fields

5. **Usage Example**
   - Green info box
   - Example: `go test`
   - Explanation of what happens

## User Interactions

### Navigating to Guide

1. From Bookmarks page, click "Learn how to set up a custom search engine" link
2. Or navigate directly to `/search-engine-guide`
3. Guide loads with personalized search URL

### Setting Up Search Engine

1. Read "How It Works" section
2. Copy the personalized search URL
3. Follow browser-specific instructions:
   - Open browser settings
   - Navigate to search engine settings
   - Add custom search engine
   - Fill in form with:
     - Name: SlugBase (or preferred name)
     - Keyword: go (or preferred keyword)
     - URL: Use the provided search URL
4. Test by typing `go {slug}` in address bar

### Returning to Bookmarks

1. Click "Back" button in header
2. Returns to Bookmarks page

## Component Structure

```tsx
<SearchEngineGuide>
  <Header>
    <Back Button>
    <Title>
    <Description>
  </Header>
  <How It Works Section>
    <Explanation>
    <Example>
  </How It Works>
  <Your Search URL Section>
    <Title>
    <Code Display>
    <Note>
  </Your Search URL>
  <Chromium Section>
    <Title>
    <Steps>
  </Chromium>
  <Firefox Section>
    <Title>
    <Steps>
  </Firefox>
  <Usage Example Section>
    <Title>
    <Example>
    <Explanation>
  </Usage Example>
</SearchEngineGuide>
```

## Personalized Search URL

The search URL is dynamically generated based on:
- **Base URL**: Current application origin
- **Base URL**: Current application origin
- **Placeholder**: `%s` for the bookmark slug

**Format**: `{BASE_URL}/go/%s` (same for all users; login required)

**Example**: `https://slugbase.example.com/go/%s`

The `%s` is replaced by the browser with the search query (bookmark slug).

## Browser Setup Instructions

### Chromium-based Browsers

1. Open browser settings
2. Navigate to 'Search engine' or 'Search' settings
3. Click 'Manage search engines' or 'Add'
4. Fill in form:
   - Name: SlugBase (or any name)
   - Keyword: go (or any keyword)
   - URL: Use the search URL shown above
5. Click 'Add' or 'Save'

### Firefox

1. Open Firefox settings
2. Navigate to 'Search' in settings menu
3. Scroll down and click 'Add' under 'One-Click Search Engines'
4. Fill in form:
   - Name: SlugBase (or any name)
   - Keyword: go (or any keyword)
   - URL: Use the search URL shown above
5. Click 'Add'

## Usage Example

After setup, users can:

1. Type in browser address bar: `go test`
2. Press Enter
3. Browser navigates to: `{BASE_URL}/go/test`
4. SlugBase redirects to the bookmark URL associated with slug "test"

**Note**: Replace "test" with any bookmark slug created in SlugBase.

## How It Works

The custom search engine feature works by:

1. User types keyword + slug in address bar (e.g., `go mylink`)
2. Browser replaces keyword and query with search URL
3. Browser navigates to: `{BASE_URL}/go/mylink`
4. SlugBase backend receives request
5. Backend looks up bookmark by slug (user identified by session)
6. If found and forwarding enabled, redirects to bookmark URL
7. User is taken directly to the target website

## Benefits

1. **Quick Access**: Access bookmarks without opening SlugBase
2. **Keyboard-First**: No mouse required
3. **Universal**: Works from any browser tab/window
4. **Customizable**: Choose your own keyword
5. **Privacy**: Bookmarks remain private, only you can access

## Related Pages

- [Bookmarks](bookmarks) - Create bookmarks with slugs
- [Profile](profile) - Manage account and remembered slug choices

## Technical Details

- **Component File**: `frontend/src/pages/SearchEngineGuide.tsx`
- **Authentication**: Login required; resolution is per-user
- **Dynamic URL**: Generates search URL from current origin
- **Routing**: React Router for navigation

## i18n Keys Used

- `searchEngineGuide.*` - All guide-related strings
- `common.back` - Back button text

## Styling

- **Info Boxes**: Color-coded sections (blue, green)
- **Code Blocks**: Monospace font, proper formatting
- **Step Lists**: Numbered lists for instructions
- **Icons**: Checkmarks and code icons for visual clarity
- **Responsive**: Mobile-friendly layout
- **Dark Mode**: Full dark/light mode support

## Content Sections

### How It Works

Explains the concept:
- Custom search engine setup
- Keyword + slug usage
- Browser integration
- Visual example

### Your Search URL

![Search URL Display](../assets/search-engine-guide-url.png)

Shows personalized URL:
- User-specific URL template
- Code formatting
- Placeholder explanation
- Note about URL template usage

### Browser Instructions

Step-by-step guides:
- Browser-specific navigation paths
- Form field instructions
- Screenshot descriptions (text-based)
- Completion confirmation

### Usage Example

Practical demonstration:
- Example keyword usage
- Expected behavior
- Real-world scenario
- Tips for best experience

## Best Practices

1. **Choose Memorable Keyword**: Use short, easy-to-remember keyword
2. **Test Setup**: Verify search engine works before relying on it
3. **Use Descriptive Slugs**: Create meaningful bookmark slugs
4. **Keep Guide Handy**: Reference if switching browsers
5. **Share with Team**: Useful for team members (with their own URLs)

## Troubleshooting

### Search Engine Not Working

- Verify URL template is correct
- Check that bookmark slug exists
- Ensure forwarding is enabled on bookmark
- Verify keyword is typed correctly

### URL Template Issues

- Ensure `%s` placeholder is included
- Ensure you are logged in
- Verify base URL is correct
- Test URL manually in browser

### Browser-Specific Issues

- Different browsers may have slightly different UI
- Some browsers may require additional permissions
- Browser updates may change settings location

## User Experience

1. **Clear Instructions**: Step-by-step guidance
2. **Visual Examples**: Code blocks and examples
3. **Browser Coverage**: Instructions for major browsers
4. **Personalized**: Shows user-specific URL
5. **Easy Navigation**: Back button to return
6. **Comprehensive**: Covers all necessary information

## Accessibility

- Proper heading hierarchy
- Clear section organization
- Code blocks properly formatted
- Keyboard navigation support
- Screen reader friendly
