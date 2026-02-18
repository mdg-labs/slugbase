# SlugBase

**Your links. Your structure. Your language. Your rules.**

SlugBase is an open-source, self-hosted bookmark manager with optional link forwarding. Store and organize your bookmarks, and optionally expose them as personal short redirect URLs.

## Try SlugBase

Sign up for a free account at **[https://slugbase.app](https://slugbase.app)** to try SlugBase Cloud without self-hosting. The Free Plan lets you explore bookmarks, folders, tags, and link forwarding.

## Features

### Core Functionality
- 📚 **Bookmark Management** - Store and organize your bookmarks with titles, URLs, and optional custom slugs
- 🔗 **Link Forwarding** - Optional short redirect URLs via `/go/:slug` for easy sharing and browser custom search
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
- ☁️ **GCP / Cloud Run** - Terraform and GitHub Actions (WIF) to deploy the backend to Cloud Run; see [docs/infra/terraform](https://docs.slugbase.app/infra/terraform)
- 🪰 **Fly.io + Neon** - Deploy backend to Fly.io with Neon PostgreSQL (EU); see [docs/infra/fly-neon](https://docs.slugbase.app/infra/fly-neon)
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
- Fixed OIDC providers only: Google, Microsoft, GitHub, configured via environment variables (`OIDC_GOOGLE_CLIENT_ID`, `OIDC_GOOGLE_CLIENT_SECRET`, etc.). Admin “OIDC providers” tab is hidden. Transactional email is sent via Postmark API (`POSTMARK_SERVER_API_TOKEN`, `POSTMARK_FROM`); Admin “Settings” tab is hidden in CLOUD.
- Marketing pages at `/`, `/pricing`, `/contact`; app at `/app` (e.g. `/app/login`, `/app/bookmarks`).
- CORS and cookie domain (e.g. `COOKIE_DOMAIN=.slugbase.app`) must be set so the frontend (e.g. app.slugbase.app) can call the API (api.slugbase.app) with credentials.

**CLOUD backend env vars:** `FRONTEND_URL`, `BASE_URL`, `JWT_SECRET`, `ENCRYPTION_KEY`; optional: `COOKIE_DOMAIN`, `JWT_ACCESS_EXPIRES_IN`, `JWT_REFRESH_EXPIRES_DAYS`, `CORS_EXTRA_ORIGINS`, OIDC_* (Google/Microsoft/GitHub), Postmark (`POSTMARK_SERVER_API_TOKEN`, `POSTMARK_FROM`, `POSTMARK_FROM_NAME`) for transactional email, and AI (`AI_OPENAI_API_KEY`, `AI_OPENAI_MODEL` default gpt-4o-mini) for bookmark suggestions.

**CLOUD frontend build:** `VITE_SLUGBASE_MODE=cloud`, `VITE_API_URL=https://api.slugbase.app`.

### Sharing and forwarding (SELFHOSTED and CLOUD)

- **Access**: A user can access a bookmark if they own it or it is shared with them (direct user share, team share, or via a shared folder). Same rules apply to folders. Tags are not shared; they are per-user.
- **Forwarding URL**: The canonical link for a bookmark is always `https://<your-domain>/go/<slug>`. This URL works for you and anyone the bookmark is shared with (requires login)
- **Browser custom search**: Set up a custom search engine with URL `https://<your-domain>/go/%s` and keyword "go". Type `go <slug>` in your address bar for quick access.
- **Remembered choices**: When multiple bookmarks could match a slug, you can save a preference. Manage under Profile → Remembered Slug Choices.

## Configuration

### Environment Variables

#### Database
- `DB_TYPE` - Database type: `sqlite` (default) or `postgresql`
- `DB_PATH` - SQLite database path (default: `./data/slugbase.db`)
- `DATABASE_URL` - PostgreSQL connection string (for Neon etc.): `postgresql://user:pass@host/db?sslmode=require`. Alternative to individual params.
- `DB_HOST` - PostgreSQL host (default: `localhost`) – used when `DATABASE_URL` is not set
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

#### Email

**SELFHOSTED:** SMTP is configured via Admin Settings (Settings tab). No env vars needed.

**CLOUD:** Transactional email uses Postmark API (no SMTP). Set in `.env`:
- `POSTMARK_SERVER_API_TOKEN` - Server API token from [Postmark](https://account.postmarkapp.com)
- `POSTMARK_FROM` - Verified sender address (e.g. `noreply@slugbase.app`)
- `POSTMARK_FROM_NAME` - From display name (default: `SlugBase`)

**Both modes:**
- `CONTACT_FORM_RECIPIENT` - Email address to receive contact form submissions (optional, per environment)

#### AI Suggestions (CLOUD mode only)

- `AI_OPENAI_API_KEY` - OpenAI API key for AI bookmark suggestions (optional; required for AI on Personal/Team plans)
- `AI_OPENAI_MODEL` - Model override (default: gpt-4o-mini)

**SELFHOSTED:** AI is configured via Admin > AI Suggestions tab. No env vars needed.

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

Visit the documentation at https://docs.slugbase.app

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

The bookmark will be accessible at: `{BASE_URL}/go/my-link`

### Setting up Custom Search Engine

1. Go to Bookmarks page
2. Click "Learn how to set up a custom search engine" link
3. Follow the guide for your browser
4. Use your search URL: `{BASE_URL}/go/%s`
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
