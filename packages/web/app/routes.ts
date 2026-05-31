import { index, layout, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  route("login", "routes/auth/login.tsx"),
  route("logout", "routes/auth/logout.tsx"),
  route("forgot-password", "routes/auth/forgot-password.tsx"),
  route("reset-password", "routes/auth/reset-password.tsx"),
  layout("routes/app-layout.tsx", [index("routes/home.tsx")]),
] satisfies RouteConfig;
