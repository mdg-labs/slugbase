import { Outlet, useNavigate } from "react-router";

import { useAuth } from "../auth/AuthContext.js";
import { hasMinimumRole } from "../auth/roles.js";
import { AppShell, type NavItem } from "../components/AppShell.js";

const baseNav: NavItem[] = [
  { to: "/", label: "Overview", end: true },
  { to: "/accounts", label: "Accounts" },
  { to: "/workspaces", label: "Workspaces" },
  { to: "/billing", label: "Billing" },
];

export function ProtectedLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  if (user === null) {
    return null;
  }

  const navItems = hasMinimumRole(user.role, "platform_admin")
    ? [...baseNav, { to: "/operators", label: "Operator invites" }]
    : baseNav;

  return (
    <AppShell
      navItems={navItems}
      userEmail={user.email}
      onLogout={() => {
        void (async () => {
          await logout();
          void navigate("/login", { replace: true });
        })();
      }}
    >
      <Outlet />
    </AppShell>
  );
}
