# slugbase-core

This package contains the SlugBase core backend and frontend build artifacts. It is published from the [slugbase](https://github.com/mdg-labs/slugbase) repository.

- **Standalone**: Run `npm start` (or `node dist/backend/index.js`) to run the self-hosted server. Set `NODE_ENV=production` and ensure env vars (e.g. `DB_PATH`, `JWT_SECRET`, `SESSION_SECRET`, `ENCRYPTION_KEY`) are set.
- **SlugBase Cloud**: Use as a dependency; mount the Express app or run the server behind your cloud API.

Full documentation: [https://docs.slugbase.app](https://docs.slugbase.app)
