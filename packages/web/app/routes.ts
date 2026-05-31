import { index, layout, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  route("login", "routes/auth/login.tsx"),
  route("logout", "routes/auth/logout.tsx"),
  route("mfa", "routes/auth/mfa.tsx"),
  route("mfa/enroll", "routes/auth/mfa-enroll.tsx"),
  layout("routes/app-layout.tsx", [index("routes/home.tsx")]),
] satisfies RouteConfig;
