# Embedding the SlugBase Core Frontend

When embedding the core app in another host (e.g. SlugBase Cloud), the host must satisfy the following contract so the core `App` component works correctly.

## Host contract

### 1. i18n

- The host must **initialize i18n** (e.g. `i18n.use(initReactI18next).init(...)`) with at least the core namespaces/keys (**before** rendering the core `App`).
- Required keys include: `app`, `auth`, `common` (e.g. `common.loading`, `common.error`, `common.reload`, `auth.login`, etc.). See the core repo’s `frontend/src/locales/en.json` for the full set.
- The core does **not** run its own `i18n.ts` when consumed via `import { App } from '@mdguggenbichler/slugbase-core/frontend'` — only `frontend/index.tsx` → `./src/App` is loaded, so the host’s i18n instance is the one used by core components.

### 2. Router

- The host must provide **exactly one** `BrowserRouter` (or equivalent) for the subtree where the core `App` is rendered, with the desired `basename` (e.g. `/app`).
- The host must pass **`routerBasename`** (e.g. `""`) to the core `App` so the core does **not** render a second router. Nested `BrowserRouter`s can cause broken routing and hooks.

### 3. Props

- **`basePath`**: Base path for app routes (e.g. `"/app"` when the app is mounted at `/app/*`).
- **`apiBaseUrl`**: API base URL (e.g. `""` for same-origin, or full URL if the frontend is on a different origin).

Example:

```tsx
<BrowserRouter basename="/app">
  <App basePath="/app" apiBaseUrl="" routerBasename="" />
</BrowserRouter>
```

## Build / bundling

- The package ships **source** (`frontend/src`). The host’s bundler (e.g. Vite) must resolve the package’s `@/` alias to `node_modules/@mdguggenbichler/slugbase-core/frontend/src` so imports like `@/lib/utils` resolve correctly.
- Use `resolve.dedupe: ['react', 'react-dom', 'react-router-dom']` so the host and the core share a single React instance.

## Optional note in the package

In the package’s `frontend/index.tsx` or a small README inside the package, you can add: “When embedding, the host must initialize i18n and provide a single Router; see repo docs (docs/embedding.md).”
