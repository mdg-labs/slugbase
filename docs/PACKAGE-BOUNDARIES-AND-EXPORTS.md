# Package Boundaries and Export Surfaces (Option B)

This document defines the **minimum viable** package split, exact exports, extension points, and app-level responsibilities for Option B: slugbase-core as versioned packages consumed by the self-hosted app and slugbase-cloud.

**Constraints:** Keep the self-hosted experience (clone → npm install → npm run dev → works). slugbase-cloud becomes a separate app that consumes core via `@slugbase/core`. No overengineering.

---

## 1. Minimum Viable Package Split

**Recommendation: ONE package with multiple entrypoints (Option B from the prompt).**

- **Single package:** `@slugbase/core`
- **Entrypoints:** `@slugbase/core/backend`, `@slugbase/core/frontend`, `@slugbase/core` (or `@slugbase/core/types`) for shared types.

**Why one package instead of two (backend + frontend) for a solo founder:**

| Factor | One package (`@slugbase/core`) | Two packages (core-backend, core-frontend) |
|--------|--------------------------------|-------------------------------------------|
| **Versioning** | One version (e.g. 1.2.0). No “backend 1.2 + frontend 1.1” matrix. | Two versions to keep in sync or accept drift. |
| **Publishing** | One `npm publish`, one CI job on tag. | Two publishes; need lockstep or tooling. |
| **Shared types** | Live in same package; no third `shared` package. | Need a third package or duplicate types. |
| **Cognitive load** | “Core is one thing, two entrypoints.” | “Which package do I bump? Where do types live?” |
| **Consumers** | Self-hosted and cloud both do `@slugbase/core@1.2.0` and use `/backend` and `/frontend`. | Same, but two deps to manage. |

**Conclusion:** One package with subpath exports keeps a real boundary (backend vs frontend vs types) without the overhead of multiple version numbers and publishes. Solo founder: one place to version, one place to publish, one changelog.

---

## 2. Package Diagram

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                          @slugbase/core (one package)                        │
├─────────────────────────────────────────────────────────────────────────────┤
│  Entrypoints (package.json "exports"):                                       │
│    "." or "./types"  →  shared types (no Node/React deps)                   │
│    "./backend"       →  Express app factory, routes, db, migrations       │
│    "./frontend"      →  React App component, API client factory             │
├─────────────────────────────────────────────────────────────────────────────┤
│  Internal structure (not imported by consumers):                            │
│    backend/     →  auth, db, middleware, routes, services, utils             │
│    frontend/    →  components, pages, contexts, config                      │
│    types/       →  User, Bookmark, Folder, API shapes (shared)              │
└─────────────────────────────────────────────────────────────────────────────┘
         │                              │
         │                              │
         ▼                              ▼
┌─────────────────────┐        ┌─────────────────────┐
│  apps/selfhosted    │        │  slugbase-cloud     │
│  (in slugbase repo) │        │  (separate repo)    │
├─────────────────────┤        ├─────────────────────┤
│  import backend +   │        │  import backend +   │
│  frontend from      │        │  frontend from      │
│  @slugbase/core     │        │  @slugbase/core     │
│  basePath: '/'      │        │  basePath: '/app'    │
│  no extra routes    │        │  mount billing/org  │
│  default tenant     │        │  custom tenant      │
│  no entitlements    │        │  req.entitlements   │
└─────────────────────┘        └─────────────────────┘
```

---

## 3. Exact Exports

### 3.1 Backend (`@slugbase/core/backend`)

**Config and env**

- **`getConfig(env?: NodeJS.ProcessEnv): CoreConfig`**  
  Reads and validates env (JWT_SECRET, ENCRYPTION_KEY, BASE_URL, FRONTEND_URL, DB_*, etc.). Returns a typed config object; throws or returns a validation result if invalid. Consumer can pass `process.env` or a mock. No side effects.

- **`CoreConfig`** (type)  
  Typed shape: baseUrl, frontendUrl, db (type, path or connection string), jwtSecret, encryptionKey, sessionSecret, registrationsEnabled, etc. No cloud-only fields.

**Database**

- **`createDbPool(config: DbConfig): Pool`**  
  Returns a DB pool (Postgres or SQLite) from config. Consumer uses this for core routes and for running migrations.

- **`runMigrations(pool: Pool, options?: { dbType: 'sqlite' | 'postgresql' }): Promise<void>`**  
  Runs registered core migrations (001–009, 013–015, 018–020). Idempotent. Cloud runs this for core tables; cloud runs its own migrations for org/billing elsewhere.

**App factory**

- **`createApp(config: CoreConfig, options?: CreateAppOptions): express.Express`**  
  Returns an Express app with:
  - trust proxy, security headers, CORS, body parser, cookie parser
  - session store (uses pool from config; consumer must call `createDbPool` and pass config that includes pool or session store)
  - rate limiters (general, etc.)
  - **Tenant middleware:** If `options.tenantMiddleware` is provided, uses it; otherwise uses core default (sets `req.tenantId` to a single default tenant ID). This is the **only** tenant extension point: cloud passes a middleware that sets `req.tenantId` from session/org.
  - Passport init + session (OIDC + JWT setup)
  - **Does not** mount `/api/bookmarks`, `/api/folders`, etc. Those are mounted by `registerCoreRoutes`.
  - **Static frontend:** Core does **not** serve static frontend files. The app is responsible for serving the built frontend (e.g. `express.static(join(__dirname, '../public'))` in selfhosted, or a separate CDN/server for cloud). This keeps the package free of “where is the build output” and lets each app decide how to serve the UI.

- **`CreateAppOptions`** (type): `{ tenantMiddleware?: (req, res, next) => void }`

**Routes**

- **`registerCoreRoutes(app: express.Express, deps: CoreRouteDeps): void`**  
  Mounts all core API routes: auth, bookmarks, folders, tags, users, teams, tokens, admin, dashboard, go, health, config, CSRF, password-reset, email-verification, contact, OIDC providers.  
  **deps:** `{ pool, sessionStore, config }`. No `getTenantId` in deps; core always uses `req.tenantId` (set by tenant middleware before routes run).

**Optional: plan/feature gating (minimal)**

- Core does **not** implement billing or plans. For cloud to gate features (e.g. AI) by plan without touching core code:
  - Cloud mounts a middleware **before** `registerCoreRoutes` that sets `req.entitlements?: { ai?: boolean, ... }` from the user’s plan.
  - Core routes that are gatable (e.g. AI suggestions) check: if `req.entitlements` is set and the feature is false, return 403; otherwise allow. So core only reads an optional `req.entitlements`; it never calls Stripe or resolves org/plan.

**Exports summary (backend)**

```text
getConfig(env?) → CoreConfig
createDbPool(config) → Pool
runMigrations(pool, options?) → Promise<void>
createApp(config, options?) → Express
registerCoreRoutes(app, deps) → void
// Types: CoreConfig, CreateAppOptions, CoreRouteDeps
```

**No** generic plugin system, no event bus, no “registerPlugin(fn)”. Just createApp + registerCoreRoutes + optional tenantMiddleware and optional req.entitlements.

---

### 3.2 Frontend (`@slugbase/core/frontend`)

**Config (no hardcoded cloud/selfhosted)**

- The package does **not** export or hardcode `isCloud` or `mode`. It receives **basePath** and **apiBaseUrl** from the app.

**Root component**

- **`<App basePath={string} apiBaseUrl={string} />`**  
  Renders the full core UI: router (with `basename={basePath}`), auth context, layout, all core routes (dashboard, bookmarks, folders, tags, profile, admin, login, signup, password-reset, verify-email, shared, go preferences, search-engine guide, contact).  
  - **basePath:** `'/'` for self-hosted, `'/app'` for cloud (so core app lives at `/app` and cloud marketing at `/`).  
  - **apiBaseUrl:** `''` for same-origin, or full URL if frontend is served from a different origin.  
  All internal links and redirects use `basePath`; no `/app` hardcoded in the package.

**API client**

- **`createApiClient(options: { baseUrl?: string, basePath?: string }): AxiosInstance`**  
  Returns an axios instance with baseURL set (e.g. `baseUrl + basePath` or relative), interceptors for auth (JWT attach, refresh on 401 if desired). So cloud can use the same client for their own API calls if needed, or the App uses it internally via a single creation point.

**Exports summary (frontend)**

```text
App (React component, props: basePath, apiBaseUrl)
createApiClient(options) → AxiosInstance
```

**Optional (only if needed for cloud without duplicating logic):**

- **`CoreRouter basePath apiBaseUrl`** – If cloud needs to merge their routes with core routes (e.g. add Pricing in the same layout), we could export a router config or a wrapper that accepts `extraRoutes`. For minimum viable, cloud can run core App at `/app` and serve a completely separate marketing app at `/`; no need to export routes or extraRoutes in v1.

---

### 3.3 Shared types (`@slugbase/core` or `@slugbase/core/types`)

- **Types** used by both backend and frontend: `User`, `Bookmark`, `Folder`, `Tag`, `Team`, API response shapes, etc. Export from the main entrypoint or a dedicated `./types` subpath so that backend and frontend (and consumers) can import without pulling in Express or React.

---

## 4. Extension Points for slugbase-cloud

| Need | How |
|------|-----|
| **Add org/billing routes** | Cloud’s app: `const app = createApp(config, { tenantMiddleware: cloudTenant }); app.use('/api/billing', billingRoutes); app.use('/api/org', orgRoutes); registerCoreRoutes(app, deps);`. Express order of `use()` is the extension point. No hook in core. |
| **Inject tenant resolution** | Pass `options.tenantMiddleware` to `createApp`. That middleware sets `req.tenantId` from session/org/host. Core never resolves tenant; it only reads `req.tenantId`. |
| **Gate features by plan** | Cloud mounts middleware before `registerCoreRoutes` that sets `req.entitlements = { ai: true, ... }` from plan. Core routes that are gatable (e.g. AI) check `req.entitlements` if present and return 403 when not allowed. Core does not call Stripe or know about plans. |
| **Marketing links (/app/*)** | No override. Core frontend receives `basePath='/app'`. All core links are then `/app/...`. Cloud serves core at `/app` and their landing at `/`. No hardcoded `/app` in the package. |

**Summary:** Extension is “mount your middleware and routes before core, and pass basePath/apiBaseUrl to the frontend.” No plugin registry, no event bus.

---

## 5. App-Level Responsibilities (NOT in core packages)

These **must** remain in the app (selfhosted or cloud), not inside `@slugbase/core`:

| Responsibility | Where it lives |
|----------------|----------------|
| **Fly.io / deployment config** | slugbase-cloud repo (fly.toml, deploy workflows). Optional fly.toml for self-hosted can stay in apps/selfhosted or be removed from core. |
| **Stripe / billing** | slugbase-cloud only. Routes, webhooks, plan limits. |
| **Org / multi-tenant resolution** | slugbase-cloud only. Middleware that sets `req.tenantId` from org/session; core only reads `req.tenantId`. |
| **Cloud-only UI** | slugbase-cloud. Landing, pricing, terms, imprint. Can be a separate Next.js/static site or same server with static routes. |
| **Secrets and env handling** | App. Loading `.env`, Fly secrets, etc. Core only validates and reads config (getConfig); it doesn’t own where env comes from. |
| **Unregistered migrations 010–012, 016–017** | Either removed from core repo or moved to slugbase-cloud and run only in cloud app startup. They must not be part of `runMigrations` in the package. |

---

## 6. Proposed Folder Layout (slugbase repo)

```text
slugbase/                          # repo root
├── package.json                   # workspaces: ["packages/*", "apps/*"]
├── packages/
│   └── core/                      # @slugbase/core
│       ├── package.json           # name: "@slugbase/core", exports: ".", "./backend", "./frontend"
│       ├── types/                 # shared types (no runtime deps)
│       │   ├── src/
│       │   └── package.json       # or just types at core/src/types
│       ├── backend/               # entrypoint ./backend
│       │   ├── src/
│       │   │   ├── index.ts       # re-exports createApp, registerCoreRoutes, getConfig, createDbPool, runMigrations
│       │   │   ├── app.ts         # createApp implementation
│       │   │   ├── routes.ts      # registerCoreRoutes implementation
│       │   │   ├── config.ts
│       │   │   ├── db/
│       │   │   ├── auth/
│       │   │   ├── middleware/
│       │   │   ├── routes/
│       │   │   └── ...
│       │   └── package.json
│       └── frontend/              # entrypoint ./frontend
│           ├── src/
│           │   ├── index.ts       # re-exports App, createApiClient
│           │   ├── App.tsx
│           │   ├── api/
│           │   ├── components/
│           │   ├── pages/
│           │   └── ...
│           └── package.json
├── apps/
│   └── selfhosted/                # self-hosted app (thin)
│       ├── package.json           # dependencies: @slugbase/core
│       ├── backend-entry.ts       # getConfig, createDbPool, runMigrations, createApp, registerCoreRoutes, listen
│       ├── frontend-entry.tsx     # render <App basePath="/" apiBaseUrl="" />
│       ├── Dockerfile
│       └── ...
├── docs/                          # internal docs (releasing, SAAS-PREVENTION, etc.)
└── .github/
```

**Alternative (minimal change from today):** Keep `backend/` and `frontend/` at repo root as they are today, and add a `packages/core/` that re-exports them under a single package with subpath exports. That implies the package is a “wrapper” that re-exports from `../../backend` and `../../frontend`. That can work for a first step: same code, new package boundary and entrypoints. Then later you can move backend and frontend under `packages/core/` for a cleaner layout. The document above assumes the target layout; the first implementation could be “packages/core/backend” → re-export from root backend, same for frontend.

---

## 7. Do Not Overengineer

**Do NOT build:**

- **Generic plugin system** – No “core.use(plugin)” or registry of plugins. Extension is “mount Express middleware and routes before core” and “pass basePath/apiBaseUrl.”
- **Event bus** – No pub/sub for “user created” or “bookmark added” unless a concrete feature (e.g. webhooks) requires it. Prefer direct calls and optional `req.entitlements` for gating.
- **Abstract “adapter” layer** – No IBookmarkRepository, IAuthProvider interfaces unless you have two real implementations. One DB, one auth model.
- **Versioned API in the package** – No `/v1/` vs `/v2/` inside core. One API surface; evolve with semver of the package.
- **Separate “core-types” package** – Types live inside `@slugbase/core` (same package, different entrypoint). No extra package for a handful of types.
- **Feature-flag framework** – Plan gating is “middleware sets req.entitlements; core reads it.” No generic flag service in core.
- **SaaS-specific code in core** – No Stripe, no org resolution, no “if (isCloud)” in the package. Mode is “what basePath did the app pass?” and “what tenantMiddleware did the app pass?”

**Keep it realistic:**

- One package, two entrypoints (backend, frontend), one version.
- Backend: createApp + registerCoreRoutes + getConfig + createDbPool + runMigrations; optional tenantMiddleware and req.entitlements.
- Frontend: App(basePath, apiBaseUrl) + createApiClient.
- Cloud extends by composing Express and by passing config; no plugins, no events, no new frameworks.

---

## 8. Quick Reference

**Exports per package**

| Entrypoint | Exports |
|------------|---------|
| `@slugbase/core/backend` | getConfig, createDbPool, runMigrations, createApp, registerCoreRoutes; types: CoreConfig, CreateAppOptions, CoreRouteDeps |
| `@slugbase/core/frontend` | App, createApiClient |
| `@slugbase/core` (or ./types) | Shared types (User, Bookmark, etc.) |

**Extension hooks**

| Hook | Where | How |
|------|--------|-----|
| Tenant resolution | createApp(options) | options.tenantMiddleware |
| Add routes | Express | app.use('/api/...', routes) before registerCoreRoutes |
| Plan gating | req.entitlements | Cloud middleware sets it; core reads it in gatable routes |
| Base path / API URL | Frontend | App({ basePath, apiBaseUrl }) |

**App-only (never in core)**

- Fly.io and deployment config
- Stripe and billing
- Org and multi-tenant resolution
- Cloud-only UI (landing, pricing)
- Deploy scripts and secrets handling
- Cloud-only migrations (010–012, 016–017)
