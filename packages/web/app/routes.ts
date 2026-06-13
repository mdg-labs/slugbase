import { index, layout, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  route("health", "routes/health.ts"),
  route("version", "routes/version.ts"),
  route("login", "routes/auth/login.tsx"),
  route("logout", "routes/auth/logout.tsx"),
  route("mfa", "routes/auth/mfa/challenge.tsx"),
  route("mfa/enroll", "routes/auth/mfa/enroll.tsx"),
  route("register", "routes/auth/register.tsx"),
  route("verify-email", "routes/auth/verify-email.tsx"),
  route("verify-email-change", "routes/auth/verify-email-change.tsx"),
  route("setup", "routes/setup/setup.tsx"),
  route("forgot-password", "routes/auth/forgot-password.tsx"),
  route("reset-password", "routes/auth/reset-password.tsx"),

  // Proxy routes - forward backend API requests to the NestJS backend.
  // These sit before the app layout so they match bare paths like
  // /auth/csrf-token, /workspaces, etc. without the app layout shell.
  // Each route uses a unique file path to avoid React Router dedup errors.
  // More specific routes (bulk/*) are listed before parameterized ones (:id/*).
  route("auth/*", "routes/api/proxy/proxy-auth.ts"),
  route("bookmarks/favicon", "routes/api/proxy/proxy-bookmark-favicon.ts"),
  route("bookmarks/bulk/*", "routes/api/proxy/proxy-bookmark-bulk.ts"),
  route("bookmarks/:id/*", "routes/api/proxy/proxy-bookmark-item.ts"),
  route("tags/:id/*", "routes/api/proxy/proxy-tag-item.ts"),
  route("folders/:id/*", "routes/api/proxy/proxy-folder-item.ts"),
  route("workspaces", "routes/api/proxy-item/workspace-root.ts"),
  route("workspaces/*", "routes/api/proxy/proxy-workspaces.ts"),
  route("members", "routes/api/proxy-item/members-root.ts"),
  route("members/*", "routes/api/proxy/proxy-members.ts"),
  route("workspace/*", "routes/api/proxy/proxy-workspace.ts"),
  route("teams", "routes/api/proxy-item/teams-root.ts"),
  route("teams/*", "routes/api/proxy/proxy-teams.ts"),
  route("sharing/*", "routes/api/proxy/proxy-sharing.ts"),
  route("audit/*", "routes/api/proxy/proxy-audit.ts"),
  route("ai/*", "routes/api/proxy/proxy-ai.ts"),
  route("analytics/consent", "routes/api/proxy-item/analytics-consent-root.ts"),

  // Existing API proxy routes with specific request handling
  route("api/search", "routes/api/search.ts"),
  route("api/go/:slug", "routes/api/go.ts"),
  route("api/go/:slug/choose", "routes/api/go-choose.ts"),
  route("api/import/:kind", "routes/api/import.ts"),

  // Raw backend list/mutation proxies — used by client-side fetch
  // (bookmark-modal-api, bookmarks-api toolbar options) to bypass
  // the page loaders which transform the response shape.
  route("api/bookmarks", "routes/api/proxy/proxy-bookmarks-root.ts"),
  route("api/bookmarks/:subpath", "routes/api/proxy/proxy-bookmarks-sub.ts"),
  route("api/folders", "routes/api/proxy/proxy-folders-root.ts"),
  route("api/folders/:subpath", "routes/api/proxy/proxy-folders-sub.ts"),
  route("api/tags", "routes/api/proxy/proxy-tags-root.ts"),
  route("api/tags/:subpath", "routes/api/proxy/proxy-tags-sub.ts"),

  layout("routes/app-layout.tsx", [
    index("routes/dashboard/index.tsx"),
    route("bookmarks", "routes/bookmarks/index.tsx"),
    route("folders", "routes/folders/index.tsx"),
    route("tags", "routes/tags/index.tsx"),
    route("go/:slug", "routes/go/index.tsx"),
    layout("routes/settings/settings-layout.tsx", [
      route("settings/account", "routes/settings/account/index.tsx"),
      route("settings/workspace", "routes/settings/workspace/index.tsx"),
      route("settings/billing", "routes/settings/billing/index.tsx"),
      route("settings/members", "routes/settings/members/index.tsx"),
      route("settings/audit", "routes/settings/audit/index.tsx"),
    ]),
    route("*", "routes/not-found.tsx"),
  ]),
] satisfies RouteConfig;