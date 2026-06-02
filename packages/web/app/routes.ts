import { index, layout, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  route("health", "routes/health.ts"),
  route("version", "routes/version.ts"),
  route("login", "routes/auth/login.tsx"),
  route("logout", "routes/auth/logout.tsx"),
  route("mfa", "routes/auth/mfa.tsx"),
  route("mfa/enroll", "routes/auth/mfa-enroll.tsx"),
  route("register", "routes/auth/register.tsx"),
  route("verify-email", "routes/auth/verify-email.tsx"),
  route("setup", "routes/setup/setup.tsx"),
  route("forgot-password", "routes/auth/forgot-password.tsx"),
  route("reset-password", "routes/auth/reset-password.tsx"),
  route("api/search", "routes/api/search.ts"),
  layout("routes/app-layout.tsx", [
    index("routes/dashboard/index.tsx"),
    route("bookmarks", "routes/bookmarks/index.tsx"),
    route("folders", "routes/folders/index.tsx"),
    route("tags", "routes/tags/index.tsx"),
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
