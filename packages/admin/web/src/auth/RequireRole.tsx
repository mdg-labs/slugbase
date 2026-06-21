import { Navigate } from "react-router";

import { hasMinimumRole } from "./roles.js";
import { useAuth } from "./AuthContext.js";

export function RequireRole({
  minimum,
  children,
}: {
  minimum: string;
  children: React.ReactNode;
}) {
  const { user } = useAuth();

  if (user === null || !hasMinimumRole(user.role, minimum)) {
    return <Navigate to="/" replace />;
  }

  return children;
}
