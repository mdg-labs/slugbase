/**
 * Mounts all core API routes and /go slug routes on the Express app.
 * Does NOT add static file serving or error handlers.
 */

import express from 'express';
import authRoutes from './routes/auth.js';
import bookmarkRoutes from './routes/bookmarks.js';
import folderRoutes from './routes/folders.js';
import tagRoutes from './routes/tags.js';
import goRoutes, { optionalAuthForGo, handleGoSlug, handleGoRemember } from './routes/go.js';
import userRoutes from './routes/users.js';
import teamRoutes from './routes/teams.js';
import oidcProviderRoutes from './routes/oidc-providers.js';
import adminUserRoutes from './routes/admin/users.js';
import adminTeamRoutes from './routes/admin/teams.js';
import adminSettingsRoutes from './routes/admin/settings.js';
import adminStatsRoutes from './routes/admin/stats.js';
import adminAuditLogRoutes from './routes/admin/audit-log.js';
import passwordResetRoutes from './routes/password-reset.js';
import emailVerificationRoutes from './routes/email-verification.js';
import dashboardRoutes from './routes/dashboard.js';
import healthRoutes from './routes/health.js';
import tokenRoutes from './routes/tokens.js';
import configRoutes from './routes/config.js';
import { redirectRateLimiter } from './middleware/security.js';

export interface CoreRouteDeps {
  /** Reserved for future use (e.g. pool, config). Routes currently use global db. */
}

/**
 * Register all core API and /go routes. Call after createApp().
 */
export function registerCoreRoutes(app: express.Express, _deps?: CoreRouteDeps): void {
  app.use('/api/auth', authRoutes);
  app.use('/api/password-reset', passwordResetRoutes);
  app.use('/api/email-verification', emailVerificationRoutes);
  app.use('/api/bookmarks', bookmarkRoutes);
  app.use('/api/folders', folderRoutes);
  app.use('/api/tags', tagRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api/teams', teamRoutes);
  app.use('/api/tokens', tokenRoutes);
  app.use('/api/config', configRoutes);
  app.use('/api/oidc-providers', oidcProviderRoutes);
  app.use('/api/admin/users', adminUserRoutes);
  app.use('/api/admin/teams', adminTeamRoutes);
  app.use('/api/admin/settings', adminSettingsRoutes);
  app.use('/api/admin/stats', adminStatsRoutes);
  app.use('/api/admin/audit-log', adminAuditLogRoutes);
  app.use('/api/dashboard', dashboardRoutes);
  app.use('/api', healthRoutes);
  app.use('/api/go', goRoutes);

  app.get('/go/:slug/remember/:bookmarkId', redirectRateLimiter, optionalAuthForGo, (req, res) => {
    handleGoRemember(req, res).catch((err) => {
      console.error('Go remember error:', err);
      res.status(500).send('Internal Server Error');
    });
  });
  app.get('/go/:slug', redirectRateLimiter, optionalAuthForGo, handleGoSlug);
}
