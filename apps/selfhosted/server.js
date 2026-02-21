/**
 * Self-hosted SlugBase server. Uses @slugbase/core/backend.
 * Load env first, then init DB, create app, register routes, serve frontend, listen.
 */

import 'dotenv/config';
import express from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  validateEnvironmentVariables,
  initDatabase,
  loadOIDCStrategies,
  createApp,
  registerCoreRoutes,
  DatabaseSessionStore,
  errorHandler,
  notFoundHandler,
  isInitialized,
} from '@slugbase/core/backend';

validateEnvironmentVariables();

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '5000', 10);

async function start() {
  try {
    await initDatabase();
    console.log('Database initialized');

    await loadOIDCStrategies();

    const sessionStore = new DatabaseSessionStore();
    const app = createApp({ sessionStore });
    registerCoreRoutes(app, {});

    const publicDir = join(__dirname, 'public');
    app.use(express.static(publicDir));
    app.get('/', (_req, res) => {
      res.sendFile(join(publicDir, 'index.html'));
    });
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/') || req.path.startsWith('/api-docs') || req.path.startsWith('/go/')) {
        return next();
      }
      res.sendFile(join(publicDir, 'index.html'), (err) => {
        if (err) next();
      });
    });

    app.use(notFoundHandler);
    app.use(errorHandler);

    const initialized = await isInitialized();
    console.log(`System initialized: ${initialized}`);

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();
