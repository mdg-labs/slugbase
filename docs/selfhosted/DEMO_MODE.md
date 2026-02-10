---
id: demo-mode
title: Demo Mode (Technical)
sidebar_position: 15
---

# Demo Mode Documentation

## Overview

SlugBase supports a **DEMO_MODE** that automatically seeds the database with demo data and provides periodic resets for public demonstration instances. This is ideal for showcasing SlugBase without manual setup or data management.

## Features

- ✅ **Automatic Database Seeding** - Creates demo users, folders, tags, and bookmarks on first startup
- ✅ **Periodic Automatic Resets** - Configurable scheduled resets (default: daily at 3 AM UTC)
- ✅ **Manual Reset Endpoint** - Admin API endpoint to trigger immediate resets
- ✅ **Demo Mode Banner** - Visual indicator in the UI when demo mode is active
- ✅ **Demo Credentials** - Predefined login credentials for testing

## Configuration

### Environment Variables

Add to your `.env` file:

```bash
# Enable demo mode
DEMO_MODE=true

# Optional: Customize reset schedule (cron format)
# Default: "0 3 * * *" (daily at 3 AM UTC)
DEMO_RESET_SCHEDULE=0 3 * * *
```

### Cron Schedule Examples

- `0 3 * * *` - Daily at 3 AM UTC (default)
- `0 */6 * * *` - Every 6 hours
- `0 0 * * 0` - Weekly on Sunday at midnight UTC
- `0 0 1 * *` - Monthly on the 1st at midnight UTC

## Demo Data

### Users

The demo includes 3 users:

1. **Admin User**
   - Email: `admin@demo.slugbase`
   - Password: `DemoAdmin123!`
   - Role: Administrator

2. **Alice Developer**
   - Email: `alice@demo.slugbase`
   - Password: `DemoUser123!`
   - Role: Regular User

3. **Bob Designer**
   - Email: `bob@demo.slugbase`
   - Password: `DemoUser123!`
   - Role: Regular User

### Sample Content

Each user has:
- **Folders** - Organized by category (Development, Design, Personal, etc.)
- **Tags** - Relevant tags (typescript, react, design, etc.)
- **Bookmarks** - Real-world bookmarks with folder and tag relationships
- **Pinned Bookmarks** - Example pinned items

**Admin User** has 8 bookmarks including:
- React Documentation
- TypeScript Handbook
- Node.js Docs
- Docker Documentation
- MDN Web Docs
- GitHub, VS Code, Figma

**Alice Developer** has 4 bookmarks including:
- JavaScript.info
- CSS Tricks
- Stack Overflow
- Can I Use

**Bob Designer** has 5 bookmarks including:
- Dribbble
- Behance
- Unsplash
- Coolors
- Font Awesome

## API Endpoints

### Manual Reset

**POST** `/api/admin/demo-reset`

Manually trigger a database reset. Requires:
- `DEMO_MODE=true`
- Admin authentication

**Example:**
```bash
curl -X POST https://your-demo-instance.com/api/admin/demo-reset \
  -H "Cookie: token=your-jwt-token" \
  -H "Content-Type: application/json"
```

**Response:**
```json
{
  "message": "Database reset completed successfully"
}
```

## Deployment

### Docker Deployment

1. **Create `.env` file:**
```bash
DEMO_MODE=true
DEMO_RESET_SCHEDULE=0 3 * * *
JWT_SECRET=your-secret-here
ENCRYPTION_KEY=your-encryption-key-here
# ... other required variables
```

2. **Build and run:**
```bash
docker-compose up -d
```

3. **Verify seeding:**
```bash
docker-compose logs slugbase | grep "Starting database seeding"
```

### First Startup Behavior

When `DEMO_MODE=true` and the database is empty:
1. Database schema is created
2. Migrations are run
3. **Demo data is automatically seeded**
4. Scheduled reset is configured
5. Server starts normally

On subsequent startups (if database already has data):
- Seeding is skipped (data already exists)
- Scheduled reset continues to run

## Scheduled Resets

### How It Works

1. Uses `node-cron` library
2. Runs at configured schedule (UTC timezone)
3. Drops all user data
4. Reseeds with fresh demo data
5. Logs reset events

### Monitoring

Check logs for reset activity:
```bash
# View logs
docker-compose logs -f slugbase

# Look for reset messages
docker-compose logs slugbase | grep "Scheduled database reset"
```

## Security Considerations

### Important Notes

1. **Demo Mode is for Demos Only**
   - Never use `DEMO_MODE=true` in production
   - Demo credentials are intentionally simple
   - Data is periodically wiped

2. **Environment Variables**
   - Still require `JWT_SECRET` and `ENCRYPTION_KEY`
   - Demo mode warnings are shown but don't block startup

3. **Public Access**
   - Demo instances are intended for public access
   - Users can log in with demo credentials
   - Admin users can trigger manual resets

4. **Data Privacy**
   - All data is reset periodically
   - No personal information should be stored
   - Users should be aware this is a demo instance

## UI Indicators

When `DEMO_MODE=true`:
- **Yellow banner** at the top of all pages
- Shows: "DEMO MODE - This is a demonstration instance. The database is reset periodically."
- Visible to all users

## Troubleshooting

### Seeding Not Happening

**Problem:** Database not seeding on startup

**Solutions:**
1. Check `DEMO_MODE=true` in `.env`
2. Verify database is empty (check `users` table)
3. Check logs for seeding errors
4. Ensure all required environment variables are set

### Scheduled Reset Not Working

**Problem:** Automatic resets not occurring

**Solutions:**
1. Verify `node-cron` is installed: `npm list node-cron`
2. Check cron schedule format is correct
3. Review server logs for cron errors
4. Ensure server stays running (cron only works when server is active)

### Manual Reset Failing

**Problem:** `/api/admin/demo-reset` returns 403

**Solutions:**
1. Verify `DEMO_MODE=true`
2. Ensure user is authenticated as admin
3. Check API endpoint is accessible
4. Review server logs for errors

## Disabling Demo Mode

To disable demo mode:

1. Set `DEMO_MODE=false` or remove from `.env`
2. Restart the server
3. Manual seeding will no longer occur
4. Scheduled resets will stop
5. Banner will disappear from UI

**Note:** Disabling demo mode does NOT delete existing demo data. You'll need to manually clear the database if desired.

## Development

### Testing Locally

1. Set `DEMO_MODE=true` in `.env`
2. Start server: `npm run dev`
3. Database will auto-seed
4. Log in with demo credentials
5. Test features with demo data

### Modifying Demo Data

Edit `backend/src/db/seed-data.ts` to customize:
- Users and credentials
- Folders and icons
- Tags
- Bookmarks and relationships

After changes, restart the server with `DEMO_MODE=true` and a fresh database.

## Summary

Demo Mode provides a complete, automated solution for running public SlugBase demonstrations:

- ✅ Zero manual setup required
- ✅ Automatic data seeding
- ✅ Periodic automatic resets
- ✅ Manual reset capability
- ✅ Clear visual indicators
- ✅ Ready-to-use demo credentials

Perfect for showcasing SlugBase features without maintenance overhead!
