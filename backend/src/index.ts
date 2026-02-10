// IMPORTANT: Load environment variables FIRST, before any other imports
// that might use process.env at module load time
import './load-env.js';

// Now import other modules (they can safely use process.env)
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import passport from 'passport';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { initDatabase, isInitialized, queryOne, query, execute } from './db/index.js';
import { setupOIDC, loadOIDCStrategies } from './auth/oidc.js';
import { setupJWT } from './auth/jwt.js';
import { validateEnvironmentVariables } from './utils/env-validation.js';
import { seedDatabase, resetDatabase } from './db/seed.js';
import { setupSecurityHeaders, generalRateLimiter, strictRateLimiter, contactRateLimiter, redirectRateLimiter } from './middleware/security.js';
import { validateUrl } from './utils/validation.js';
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from './config/swagger.js';
import { mode, isCloud } from './config/mode.js';
import authRoutes from './routes/auth.js';
import bookmarkRoutes from './routes/bookmarks.js';
import folderRoutes from './routes/folders.js';
import tagRoutes from './routes/tags.js';
import redirectRoutes from './routes/redirect.js';
import userRoutes from './routes/users.js';
import teamRoutes from './routes/teams.js';
import oidcProviderRoutes from './routes/oidc-providers.js';
import adminUserRoutes from './routes/admin/users.js';
import adminTeamRoutes from './routes/admin/teams.js';
import adminSettingsRoutes from './routes/admin/settings.js';
import adminDemoResetRoutes from './routes/admin/demo-reset.js';
import passwordResetRoutes from './routes/password-reset.js';
import emailVerificationRoutes from './routes/email-verification.js';
import csrfRoutes from './routes/csrf.js';
import dashboardRoutes from './routes/dashboard.js';
import contactRoutes from './routes/contact.js';
import { DatabaseSessionStore } from './utils/session-store.js';

// Validate required environment variables before starting
validateEnvironmentVariables();

const app = express();
const PORT = process.env.PORT || 5000;

// Get __dirname for path resolution
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Security headers (must be early in middleware chain)
app.use(setupSecurityHeaders());

// Serve static files from frontend build in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(join(__dirname, '../../public')));
}

// Middleware
// CORS: Allow both the configured FRONTEND_URL and common development ports
// In CLOUD mode, also allow CORS_EXTRA_ORIGINS (e.g. marketing domain)
const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
const allowedOriginsBase = [
  frontendUrl,
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
];
const extraOrigins = (process.env.CORS_EXTRA_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
const allowedOrigins = [...new Set([...allowedOriginsBase, ...extraOrigins])];

app.use(cors({
  origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    // Allow requests with no origin (M2: intentional for non-browser clients e.g. mobile, Postman).
    // Browser requests send Origin; disallowed origins are rejected below.
    if (!origin) {
      return callback(null, true);
    }
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      // In development, allow any localhost origin
      if (process.env.NODE_ENV === 'development' && origin.includes('localhost')) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    }
  },
  credentials: true,
}));
app.use(express.json({ limit: '10mb' })); // Limit JSON payload size
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser()); // Parse cookies for JWT

// Session middleware (required for OIDC OAuth flow)
// M3/L4: In production SESSION_SECRET is required by env validation; fallback only for development
const sessionSecret = process.env.SESSION_SECRET || process.env.JWT_SECRET || 'slugbase-session-secret-change-in-production';
// Only use secure cookies if explicitly in production AND using HTTPS
// Check BASE_URL to determine if we're using HTTPS
const baseUrl = process.env.BASE_URL || 'http://localhost:5000';
const isHttps = baseUrl.startsWith('https://');
const isProduction = process.env.NODE_ENV === 'production' && isHttps;

// Initialize database-backed session store
const sessionStore = new DatabaseSessionStore();

app.use(session({
  secret: sessionSecret,
  resave: false, // Database store handles this
  saveUninitialized: true, // Set to true to save session even if not modified (needed for OAuth state)
  name: 'slugbase.sid', // Custom session name to avoid conflicts
  store: sessionStore, // Use database-backed store instead of MemoryStore
  cookie: {
    httpOnly: true,
    secure: isProduction, // Only secure in production with HTTPS
    sameSite: 'lax', // Use 'lax' for OIDC redirects to work properly (allows cross-site redirects)
    maxAge: 10 * 60 * 1000, // 10 minutes (only needed for OAuth flow)
    path: '/', // Ensure cookie is available for all paths
  },
}));

// General rate limiting (applied to all routes)
app.use(generalRateLimiter);

// Setup Passport strategies BEFORE initializing passport middleware
// This ensures serializeUser/deserializeUser are registered before passport.session() is used
setupOIDC(); // Setup OIDC strategies (registers serializeUser/deserializeUser for sessions)
setupJWT(); // Setup JWT strategy

// Passport initialization
// Sessions are needed for OIDC OAuth flow, but we use JWT for final authentication
app.use(passport.initialize());
app.use(passport.session()); // Required for OIDC to work (uses serialization from setupOIDC)

// Swagger API Documentation (standalone page, not in admin UI)
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
  customCss: '.swagger-ui .topbar { display: none }',
  customSiteTitle: 'SlugBase API Documentation',
}));

// Routes (register CSRF token endpoint BEFORE CSRF protection)
app.use('/api/csrf-token', csrfRoutes);

// CSRF protection for state-changing operations
// Note: CSRF tokens are provided via GET /api/csrf-token endpoint
// Exclude certain endpoints that don't need CSRF (like password reset, OIDC callbacks)
import { csrfProtection } from './middleware/security.js';
app.use((req: any, res: any, next: any) => {
  // Skip CSRF for GET, HEAD, OPTIONS, and public endpoints
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }
  // Skip CSRF for password reset, OIDC callback, auth refresh, contact form
  if (req.path.startsWith('/api/password-reset') || 
      req.path.includes('/callback') ||
      req.path === '/api/auth/setup' ||
      req.path === '/api/auth/refresh' ||
      req.path === '/api/contact' ||
      req.path === '/api/health' ||
      req.path === '/api/csrf-token' ||
      req.path.startsWith('/api-docs')) {
    return next();
  }
  // Apply CSRF protection
  csrfProtection(req, res, next);
});

// All other routes
app.use('/api/auth', authRoutes);
app.use('/api/password-reset', passwordResetRoutes);
app.use('/api/email-verification', emailVerificationRoutes);
app.use('/api/bookmarks', bookmarkRoutes);
app.use('/api/folders', folderRoutes);
app.use('/api/tags', tagRoutes);
app.use('/api/users', userRoutes);
app.use('/api/teams', teamRoutes);
app.use('/api/oidc-providers', oidcProviderRoutes);
app.use('/api/admin/users', adminUserRoutes);
app.use('/api/admin/teams', adminTeamRoutes);
app.use('/api/admin/settings', adminSettingsRoutes);
app.use('/api/admin/demo-reset', adminDemoResetRoutes);
app.use('/api/dashboard', dashboardRoutes);
if (isCloud) {
  app.use('/api/contact', contactRateLimiter, contactRoutes);
}

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Version endpoint
app.get('/api/version', (req, res) => {
  res.json({ 
    version: process.env.COMMIT_SHA || 'dev',
    commit: process.env.COMMIT_SHA || null,
    demoMode: process.env.DEMO_MODE === 'true',
    mode,
  });
});

// Redirect routes - handle 2-segment paths only (user_key/slug pattern)
// Use regex to ensure route only matches paths with exactly 2 non-empty segments
// This prevents the route from matching `/` (root path)
app.get(/^\/([^\/]+)\/([^\/]+)$/, redirectRateLimiter, async (req, res, next) => {
  try {
    // Extract user_key and slug from the matched groups
    const match = req.path.match(/^\/([^\/]+)\/([^\/]+)$/);
    if (!match) {
      return next();
    }
    const user_key = match[1];
    const slug = match[2];

    // user_key and slug are already extracted from regex match above
    if (!user_key || !slug) {
      return next();
    }

    // First, try to find a bookmark owned by this user_key
    let bookmark = await queryOne(
      `SELECT b.* FROM bookmarks b
       INNER JOIN users u ON b.user_id = u.id
       WHERE u.user_key = ? AND b.slug = ? AND b.forwarding_enabled = TRUE`,
      [user_key, slug]
    );

    // If not found, try to find a shared bookmark accessible by this user_key
    if (!bookmark) {
      // Get the user_id from the user_key
      const user = await queryOne(
        'SELECT id FROM users WHERE user_key = ?',
        [user_key]
      );

      if (user) {
        const userId = (user as any).id;

        // Get user's teams
        const userTeams = await query(
          'SELECT team_id FROM team_members WHERE user_id = ?',
          [userId]
        );
        const teamIds = Array.isArray(userTeams) ? userTeams.map((t: any) => t.team_id) : [];

        // Find shared bookmark with matching slug
        let sql = `
          SELECT DISTINCT b.*
          FROM bookmarks b
          LEFT JOIN bookmark_user_shares bus ON b.id = bus.bookmark_id
          LEFT JOIN bookmark_team_shares bts ON b.id = bts.bookmark_id
          LEFT JOIN bookmark_folders bf ON b.id = bf.bookmark_id
          LEFT JOIN folder_user_shares fus ON bf.folder_id = fus.folder_id
          LEFT JOIN folder_team_shares fts ON bf.folder_id = fts.folder_id
          WHERE b.slug = ? AND b.forwarding_enabled = TRUE AND b.user_id != ?
            AND (bus.user_id = ?
            OR (bts.team_id IN (${teamIds.length > 0 ? teamIds.map(() => '?').join(',') : 'NULL'}) AND bts.team_id IS NOT NULL)
            OR fus.user_id = ?
            OR (fts.team_id IN (${teamIds.length > 0 ? teamIds.map(() => '?').join(',') : 'NULL'}) AND fts.team_id IS NOT NULL AND bf.folder_id IS NOT NULL))
        `;
        const params: any[] = [slug, userId, userId, userId];
        if (teamIds.length > 0) {
          params.push(...teamIds);
          params.push(...teamIds); // Second set for folder shares
        }

        bookmark = await queryOne(sql, params);
      }
    }

    if (!bookmark) {
      return res.status(404).send('Not Found');
    }

    const redirectUrl = (bookmark as any).url;
    const bookmarkId = (bookmark as any).id;

    // Track access (increment access_count and update last_accessed_at)
    // Do this asynchronously so it doesn't block the redirect
    execute(
      `UPDATE bookmarks 
       SET access_count = COALESCE(access_count, 0) + 1,
           last_accessed_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [bookmarkId]
    ).catch((err) => {
      // Log error but don't fail the redirect
      console.error('Failed to track bookmark access:', err);
    });

    const urlValidation = validateUrl(redirectUrl);
    if (!urlValidation.valid) {
      console.error('Invalid redirect URL detected:', redirectUrl);
      return res.status(400).send('Invalid redirect URL');
    }

    res.redirect(302, redirectUrl);
  } catch (error: any) {
    console.error('Redirect error:', error);
    res.status(500).send('Internal Server Error');
  }
});

// Serve frontend root route in production (AFTER redirect route, since redirect requires 2 segments)
if (process.env.NODE_ENV === 'production') {
  app.get('/', (req, res) => {
    res.sendFile(join(__dirname, '../../public/index.html'));
  });
}

// Serve frontend catch-all in production (for SPA routing - before error handlers)
// This catches all non-API, non-redirect routes for SPA client-side routing
if (process.env.NODE_ENV === 'production') {
  app.get('*', (req, res, next) => {
    // Skip API routes and redirect patterns (2 segments)
    if (req.path.startsWith('/api/') || req.path.startsWith('/api-docs')) {
      return next();
    }
    const pathSegments = req.path.split('/').filter(Boolean);
    if (pathSegments.length === 2) {
      // This might be a redirect route, let it fall through
      return next();
    }
    res.sendFile(join(__dirname, '../../public/index.html'), (err) => {
      if (err) {
        console.error('Error sending index.html:', err);
        return next();
      }
    });
  });
}

// Error handling (must be last)
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
app.use(notFoundHandler);
app.use(errorHandler);

// Initialize database on startup
async function start() {
  try {
    await initDatabase();
    console.log('Database initialized');
    
    // Load OIDC strategies after database is initialized
    await loadOIDCStrategies();
    
    const initialized = await isInitialized();
    const isDemoMode = process.env.DEMO_MODE === 'true';
    
    // Handle DEMO_MODE seeding
    if (isDemoMode) {
      console.log('🎭 DEMO_MODE is enabled');
      if (!initialized) {
        console.log('Seeding database with demo data...');
        await seedDatabase();
      } else {
        console.log('Database already initialized, skipping seed');
      }
      
      // Setup scheduled reset (daily at 3 AM UTC)
      const DEMO_RESET_SCHEDULE = process.env.DEMO_RESET_SCHEDULE || '0 3 * * *';
      setupScheduledReset(DEMO_RESET_SCHEDULE);
      console.log(`📅 Scheduled reset configured: ${DEMO_RESET_SCHEDULE} (daily reset)`);
    }
    
    console.log(`System initialized: ${initialized || isDemoMode}`);
    
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      if (isDemoMode) {
        console.log('🎭 DEMO MODE: Demo credentials available - see documentation');
      }
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

/**
 * Setup scheduled database reset for DEMO_MODE
 * Uses node-cron to reset the database periodically
 */
function setupScheduledReset(cronSchedule: string) {
  try {
    // Dynamic import to avoid issues if node-cron is not installed
    import('node-cron').then((cronModule: any) => {
      const cron = cronModule.default || cronModule;
      cron.schedule(cronSchedule, async () => {
        console.log('🔄 Scheduled database reset triggered...');
        try {
          await resetDatabase();
          console.log('✅ Scheduled reset completed successfully');
        } catch (error: any) {
          console.error('❌ Error during scheduled reset:', error);
        }
      }, {
        timezone: 'UTC',
      });
      console.log(`   ✓ Reset scheduled with pattern: ${cronSchedule}`);
    }).catch((error: any) => {
      console.warn('⚠️  node-cron not available, scheduled reset disabled:', error.message);
    });
  } catch (error: any) {
    console.warn('⚠️  Could not setup scheduled reset:', error.message);
  }
}

start();
