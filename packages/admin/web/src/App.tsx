import { BrowserRouter, Navigate, Route, Routes } from "react-router";

import { AuthProvider } from "./auth/AuthContext.js";
import { RequireAuth } from "./auth/RequireAuth.js";
import { RequireRole } from "./auth/RequireRole.js";
import { ProtectedLayout } from "./layouts/ProtectedLayout.js";
import { AcceptInvitePage, LoginPage } from "./pages/LoginPage.js";
import { OverviewPage } from "./pages/OverviewPage.js";
import { AccountsPage } from "./pages/AccountsPage.js";
import { AccountDetailPage } from "./pages/AccountDetailPage.js";
import { WorkspacesPage } from "./pages/WorkspacesPage.js";
import { WorkspaceDetailPage } from "./pages/WorkspaceDetailPage.js";
import { BillingPage } from "./pages/BillingPage.js";
import { OperatorInvitesPage } from "./pages/OperatorInvitesPage.js";

export function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/accept-invite" element={<AcceptInvitePage />} />
          <Route
            element={
              <RequireAuth>
                <ProtectedLayout />
              </RequireAuth>
            }
          >
            <Route index element={<OverviewPage />} />
            <Route path="accounts" element={<AccountsPage />} />
            <Route path="accounts/:id" element={<AccountDetailPage />} />
            <Route path="workspaces" element={<WorkspacesPage />} />
            <Route path="workspaces/:id" element={<WorkspaceDetailPage />} />
            <Route path="billing" element={<BillingPage />} />
            <Route
              path="operators"
              element={
                <RequireRole minimum="platform_admin">
                  <OperatorInvitesPage />
                </RequireRole>
              }
            />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
