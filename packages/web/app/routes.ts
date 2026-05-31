import { index, layout, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  route("login", "routes/auth/login.tsx"),
  route("logout", "routes/auth/logout.tsx"),
  layout("routes/app-layout.tsx", [index("routes/home.tsx")]),
] satisfies RouteConfig;
