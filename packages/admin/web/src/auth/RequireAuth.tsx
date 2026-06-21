import { Navigate, useLocation } from "react-router";

import { useAuth } from "./AuthContext.js";

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="auth-loading" data-testid="auth-loading">
        Loading session…
      </div>
    );
  }

  if (user === null) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return children;
}
