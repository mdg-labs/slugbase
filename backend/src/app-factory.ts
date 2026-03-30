/**
 * Creates the Express app with middleware (security, CORS, session, passport, tenant, CSRF).
 * Does NOT mount API routes, static files, or error handlers - those are added by registerCoreRoutes and the app entry.
 */

import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import passport from 'passport';
import { setupOIDC, loadOIDCStrategies } from './auth/oidc.js';
import { setupJWT } from './auth/jwt.js';
import {
  setupSecurityHeaders,
  generalRateLimiter,
  redirectRateLimiter,
} from './middleware/security.js';
import { tenantMiddleware } from './middleware/tenant.js';
import { csrfProtection } from './middleware/security.js';
import { DatabaseSessionStore } from './utils/session-store.js';
import csrfRoutes from './routes/csrf.js';

export interface CreateAppOptions {
  /** If provided, used instead of the default single-tenant middleware. Used by cloud to set req.tenantId from org/session. */
  tenantMiddleware?: (req: express.Request, res: express.Response, next: express.NextFunction) => void;
  /** Database-backed session store (must be created after DB init). */
  sessionStore: InstanceType<typeof DatabaseSessionStore>;
}

/**
 * Build Express app with all core middleware. Call registerCoreRoutes(app, deps) next to mount API routes.
 */
export function createApp(options: CreateAppOptions): express.Express {
  const { sessionStore, tenantMiddleware: customTenantMiddleware } = options;

  const app = express();
  app.set('trust proxy', 1);

  app.use(setupSecurityHeaders());

  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  const allowedOriginsBase = [
    frontendUrl,
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:3002', // e2e frontend (run-e2e.js uses port 3002)
    'http://127.0.0.1:3000',
    'http://127.0.0.1:3001',
    'http://127.0.0.1:3002',
  ];
  const extraOrigins = (process.env.CORS_EXTRA_ORIGINS || '')
    .split(',')
    .map((o: string) => o.trim())
    .filter(Boolean);
  const allowedOrigins = [...new Set([...allowedOriginsBase, ...extraOrigins])];

  app.use(
    cors({
      origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) return callback(null, true);
        if (process.env.NODE_ENV === 'development' && origin.includes('localhost')) return callback(null, true);
        callback(new Error('Not allowed by CORS'));
      },
      credentials: true,
    })
  );
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));
  app.use(cookieParser());

  const DEFAULT_SESSION_SECRET = 'slugbase-session-secret-change-in-production';
  const sessionSecret = process.env.SESSION_SECRET || process.env.JWT_SECRET || DEFAULT_SESSION_SECRET;
  if (process.env.NODE_ENV === 'production' && sessionSecret === DEFAULT_SESSION_SECRET) {
    throw new Error('Cannot use default session secret in production. Set SESSION_SECRET.');
  }
  const baseUrl = process.env.BASE_URL || 'http://localhost:5000';
  const isHttps = baseUrl.startsWith('https://');
  const isProduction = process.env.NODE_ENV === 'production' && isHttps;

  app.use(
    session({
      secret: sessionSecret,
      resave: false,
      saveUninitialized: true,
      name: 'slugbase.sid',
      store: sessionStore,
      cookie: {
        httpOnly: true,
        secure: isProduction,
        sameSite: 'lax',
        maxAge: 10 * 60 * 1000,
        path: '/',
      },
    })
  );

  app.use(generalRateLimiter);
  app.use(customTenantMiddleware ?? tenantMiddleware);

  setupOIDC();
  setupJWT();
  app.use(passport.initialize());
  app.use(passport.session());

  app.use('/api/csrf-token', csrfRoutes);

  app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (
      req.path.startsWith('/api/password-reset') ||
      req.path === '/api/auth/setup' ||
      req.path === '/api/auth/refresh' ||
      req.path === '/api/auth/register' ||
      req.path === '/api/auth/verify-signup' ||
      req.path === '/api/auth/resend-signup-verification' ||
      req.path === '/api/auth/request-signup-resend' ||
      req.path === '/api/health' ||
      req.path === '/api/csrf-token'
    ) {
      return next();
    }
    csrfProtection(req, res, next);
  });

  return app;
}
