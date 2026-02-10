# SlugBase

**Your links. Your structure. Your language. Your rules.**

SlugBase is an open-source, self-hosted bookmark manager with optional link forwarding. Store and organize your bookmarks, and optionally expose them as personal short redirect URLs.

## 🚀 Try the Demo

Check out the live demo at **[https://slugbase-demo.ghotso.dev](https://slugbase-demo.ghotso.dev)**

### Demo Credentials

The demo includes pre-configured users with sample data:

**Admin User:**
- Email: `admin@demo.slugbase`
- Password: `DemoAdmin123!`

**Regular Users:**
- Alice: `alice@demo.slugbase` / `DemoUser123!`
- Bob: `bob@demo.slugbase` / `DemoUser123!`

*Note: The demo database resets hourly to restore the default state.*

## Features

### Core Functionality
- 📚 **Bookmark Management** - Store and organize your bookmarks with titles, URLs, and optional custom slugs
- 🔗 **Link Forwarding** - Optional short redirect URLs (`/{user_key}/{slug}`) for easy sharing
- 🏷️ **Tags & Folders** - Organize bookmarks with tags and folders (many-to-many relationships)
- 👥 **Sharing** - Share bookmarks and folders with teams and individual users
- 🔍 **Filtering & Sorting** - Filter by folder/tag, sort by date, alphabetically, usage, or access time
- 🔎 **Global Search** - Press `Ctrl+K` to search across bookmarks, folders, and tags from anywhere
- 📊 **View Modes** - Card view or compact list view with density controls
- 📦 **Bulk Actions** - Select multiple bookmarks for bulk operations (move, tag, share, delete)
- 📥 **Import/Export** - Import bookmarks from JSON or export your collection
- 📌 **Pinned Bookmarks** - Pin important bookmarks for quick access
- 📈 **Usage Tracking** - Automatic tracking of bookmark access counts and last accessed time
- 🌐 **Internationalization** - Full i18n support (English, German, French) with easy extension
- 🌓 **Dark/Light Mode** - Auto-detect from browser or manual toggle with theme persistence

### Authentication & Security
- 🔐 **OIDC Authentication** - Login with configurable OIDC providers (Google, GitHub, etc.)
- 🔑 **Local Authentication** - Email/password authentication as fallback
- 🛡️ **Password Reset** - Email-based password reset flow (SMTP configurable)
- 👨‍💼 **Admin System** - First user becomes admin automatically; admin panel for user/team management

### Database & Deployment
- 💾 **SQLite** - Default database (perfect for small deployments)
- 🐘 **PostgreSQL** - Full PostgreSQL support for larger deployments
- 🔄 **Auto Migrations** - Automatic database migration system with version tracking
- 🐳 **Docker Ready** - Production-ready Docker setup with multi-stage builds
- ☁️ **GCP / Cloud Run** - Terraform and GitHub Actions (WIF) to deploy the backend to Cloud Run; see [docs/infra/terraform.md](docs/infra/terraform.md)
- 📊 **API Documentation** - Auto-generated Swagger/OpenAPI documentation

## Tech Stack

### Frontend
- **React** 18+ with TypeScript
- **React Router** for navigation
- **Tailwind CSS** for styling
- **Vite** for build tooling
- **i18next** for internationalization
- **Lucide React** for icons

### Backend
- **Node.js** with Express
- **TypeScript** throughout
- **Passport.js** for authentication (OIDC + JWT)
- **SQLite** (better-sqlite3) / **PostgreSQL** (pg)
- **Swagger** for API documentation
- **Helmet** for security headers
- **Rate Limiting** for API protection

## Quick Start

### Development

1. **Clone the repository**
```bash
git clone <repository-url>
cd slugbase
```

2. **Install dependencies**
```bash
npm install
```

3. **Start development servers**
```bash
npm run dev
```

- Backend: `http://localhost:5000`
- Frontend: `http://localhost:3000`

4. **Initial Setup**

On first start, SlugBase enters **Setup Mode**. Create your first admin user:
- Navigate to the setup page
- Enter email, name, and password
- First user automatically becomes admin
- After setup, configure OIDC providers in the admin panel

### Production with Docker

1. **Build and run**
```bash
docker-compose up -d
```

2. **Access the application**
- Application: `http://localhost:5000`
- API Docs: `http://localhost:5000/api-docs`

3. **Complete setup**
- Go through initial setup flow
- Configure OIDC providers (optional)
- Configure SMTP settings for password reset (optional)

## Running modes: SELFHOSTED vs CLOUD

SlugBase supports two runtime modes. **SELFHOSTED** is the default and preserves the current behavior. **CLOUD** is for a SaaS deployment (e.g. frontend on Cloudflare Pages, backend on GCP Cloud Run).

### SELFHOSTED (default)

- No `SLUGBASE_MODE` or set to `SLUGBASE_MODE=selfhosted`.
- Single long-lived JWT cookie; no refresh tokens.
- OIDC providers configured in the admin panel (“bring your own”).
- App is served at `/`; no marketing pages.
- Docker and single-server deployments work as today.

### CLOUD (SaaS)

- Set `SLUGBASE_MODE=cloud` (backend) and build the frontend with `VITE_SLUGBASE_MODE=cloud` and `VITE_API_URL=https://api.slugbase.app` (or your API origin).
- Short-lived access JWT (e.g. 15 min) plus refresh token in an httpOnly cookie; refresh tokens stored in the DB and rotated on use.
- Fixed OIDC providers only: Google, Microsoft, GitHub, configured via environment variables (`OIDC_GOOGLE_CLIENT_ID`, `OIDC_GOOGLE_CLIENT_SECRET`, etc.). Admin “OIDC providers” tab is hidden.
- Marketing pages at `/`, `/pricing`, `/contact`; app at `/app` (e.g. `/app/login`, `/app/bookmarks`).
- CORS and cookie domain (e.g. `COOKIE_DOMAIN=.slugbase.app`) must be set so the frontend (e.g. app.slugbase.app) can call the API (api.slugbase.app) with credentials.

**CLOUD backend env vars:** `FRONTEND_URL`, `BASE_URL`, `JWT_SECRET`, `ENCRYPTION_KEY`; optional: `COOKIE_DOMAIN`, `JWT_ACCESS_EXPIRES_IN`, `JWT_REFRESH_EXPIRES_DAYS`, `CORS_EXTRA_ORIGINS`, and the OIDC_* variables for Google/Microsoft/GitHub.

**CLOUD frontend build:** `VITE_SLUGBASE_MODE=cloud`, `VITE_API_URL=https://api.slugbase.app`.

### Sharing and forwarding (SELFHOSTED and CLOUD)

- **Access**: A user can access a bookmark if they own it or it is shared with them (direct user share, team share, or via a shared folder). Same rules apply to folders. Tags are not shared; they are per-user.
- **Canonical forwarding URL**: The canonical link for a bookmark is always `https://<your-domain>/<owner_user_key>/<slug>`. The owner is the user who created the bookmark. When you copy the “forwarding URL” for a shared bookmark, the app uses the owner’s `user_key` so the link works for anyone who has access.
- **Shared users and the same link**: If a bookmark is shared with you, you can use the same canonical URL (`/<owner_user_key>/<slug>`). The redirect endpoint resolves by owner or by any user who has access to that bookmark, so shared users can safely share the same link.

## Configuration

### Environment Variables

#### Database
- `DB_TYPE` - Database type: `sqlite` (default) or `postgresql`
- `DB_PATH` - SQLite database path (default: `./data/slugbase.db`)
- `DB_HOST` - PostgreSQL host (default: `localhost`)
- `DB_PORT` - PostgreSQL port (default: `5432`)
- `DB_NAME` - PostgreSQL database name (default: `slugbase`)
- `DB_USER` - PostgreSQL user
- `DB_PASSWORD` - PostgreSQL password

#### Server
- `PORT` - Server port (default: `5000`)
- `NODE_ENV` - Environment: `development` or `production`
- `SESSION_SECRET` - Session secret (change in production!)
- `BASE_URL` - Base URL for redirects (e.g., `https://slugbase.example.com`)
- `FRONTEND_URL` - Frontend URL for CORS (default: `http://localhost:3000`)

#### Email (SMTP)
- `SMTP_ENABLED` - Enable SMTP (default: `false`)
- `SMTP_HOST` - SMTP host (e.g., `smtp.gmail.com`)
- `SMTP_PORT` - SMTP port (default: `587`)
- `SMTP_SECURE` - Use TLS/SSL (default: `false`)
- `SMTP_USER` - SMTP username
- `SMTP_PASSWORD` - SMTP password
- `SMTP_FROM_EMAIL` - From email address
- `SMTP_FROM_NAME` - From name

### Database Migrations

SlugBase uses an automatic migration system:

1. **Migrations Location**: `backend/src/db/migrations/`
2. **Naming Convention**: `NNN_migration_name.ts` (e.g., `001_migrate_slug_nullable.ts`)
3. **Auto-registration**: All migrations are auto-registered on startup
4. **Tracking**: Applied migrations are tracked in `schema_migrations` table
5. **Execution**: Migrations run automatically after initial schema setup

To add a new migration:
1. Create a new file: `backend/src/db/migrations/002_your_migration.ts`
2. Export: `migrationId`, `migrationName`, `up()` function, and optionally `down()` function
3. Import and register in `backend/src/db/migrations/index.ts`

## Project Structure

```
slugbase/
├── backend/
│   ├── src/
│   │   ├── auth/          # Authentication logic (JWT, OIDC)
│   │   ├── config/        # Configuration files
│   │   ├── db/            # Database layer
│   │   │   ├── migrations/ # Database migrations
│   │   │   ├── schema.sql  # Initial schema
│   │   │   └── index.ts    # DB utilities
│   │   ├── middleware/    # Express middleware
│   │   ├── routes/        # API routes
│   │   ├── utils/         # Utility functions
│   │   └── index.ts       # Server entry point
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── api/           # API client
│   │   ├── components/    # React components
│   │   │   ├── admin/     # Admin components
│   │   │   ├── modals/    # Modal components
│   │   │   └── ui/        # UI components
│   │   ├── contexts/      # React contexts
│   │   ├── hooks/         # Custom hooks
│   │   ├── locales/       # i18n translations
│   │   ├── pages/         # Page components
│   │   └── utils/         # Utility functions
│   └── package.json
├── docs/                   # Documentation source
├── docker-compose.yml      # Docker Compose config
├── Dockerfile              # Production Dockerfile
└── package.json            # Root workspace config
```

## Documentation

Visit the documentation at https://slugbase.ghotso.dev

## API Documentation

Interactive API documentation is available at `/api-docs` when the server is running. The API uses:
- **JWT** tokens for authentication (except login/setup endpoints)
- **RESTful** design principles
- **OpenAPI/Swagger** specification

## Usage Examples

### Creating a Bookmark with Forwarding

1. Click "Create Bookmark"
2. Enter title and URL
3. Optionally set a custom slug (e.g., `my-link`)
4. Enable "Forwarding Enabled"
5. Add folders and tags
6. Save

The bookmark will be accessible at: `{BASE_URL}/{your_user_key}/my-link`

### Setting up Custom Search Engine

1. Go to Bookmarks page
2. Click "Learn how to set up a custom search engine" link
3. Follow the guide for your browser
4. Use your search URL: `{BASE_URL}/{user_key}/%s`
5. Set keyword (e.g., `go`)
6. Access bookmarks by typing: `go {slug}` in your address bar

### Sharing Bookmarks

1. Create or edit a bookmark
2. Click the share icon
3. Select teams or individual users
4. Shared users will see the bookmark in their "Shared" page

## Development

### Building

```bash
npm run build
```

Builds both frontend and backend for production.

### Adding a New Language

1. Create `frontend/src/locales/{lang}.json`
2. Copy structure from `en.json`
3. Translate all strings
4. Import in `frontend/src/i18n.ts`
5. Add language option in Profile page

### Adding a New Migration

1. Create `backend/src/db/migrations/NNN_description.ts`
2. Export migration functions (see existing migrations for structure)
3. Import and register in `backend/src/db/migrations/index.ts`
4. Migrations run automatically on next server start

## Security

- Passwords are hashed using bcrypt
- JWT tokens with secure configuration
- Helmet.js security headers
- Rate limiting on authentication endpoints
- CORS configuration
- SQL injection protection (parameterized queries)
- XSS protection (React's built-in escaping)
- CSRF protection on state-changing operations

See [SECURITY.md](./SECURITY.md) for more details.

## Contributing

We welcome contributions! Please see [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines on how to contribute to SlugBase.

## License

This project is licensed under the MIT License - see the [LICENSE](./LICENSE) file for details.

---

**SlugBase** – Your links. Your structure. Your language. Your rules.
