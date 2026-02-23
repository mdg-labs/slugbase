// IMPORTANT: Load environment variables FIRST, before any other imports
import './load-env.js';

import express from 'express';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { validateEnvironmentVariables } from './utils/env-validation.js';
import { initDatabase, isInitialized } from './db/index.js';
import { loadOIDCStrategies } from './auth/oidc.js';
import { createApp } from './app-factory.js';
import { registerCoreRoutes } from './register-routes.js';
import { DatabaseSessionStore } from './utils/session-store.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';

validateEnvironmentVariables();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PORT = parseInt(process.env.PORT || '5000', 10);

async function start() {
  try {
    await initDatabase();
    console.log('Database initialized');

    await loadOIDCStrategies();

    const sessionStore = new DatabaseSessionStore();
    const app = createApp({ sessionStore });
    registerCoreRoutes(app, {});

    if (process.env.NODE_ENV === 'production') {
      app.use(express.static(join(__dirname, '../../public')));
    }

    if (process.env.NODE_ENV === 'production') {
      app.get('/', (_req, res) => {
        res.sendFile(join(__dirname, '../../public/index.html'));
      });
    }

    app.get('*', (req, res, next) => {
      if (process.env.NODE_ENV !== 'production') return next();
      if (req.path.startsWith('/api/') || req.path.startsWith('/go/')) {
        return next();
      }
      res.sendFile(join(__dirname, '../../public/index.html'), (err) => {
        if (err) {
          console.error('Error sending index.html:', err);
          return next();
        }
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
