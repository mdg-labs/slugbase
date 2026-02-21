import React, { Suspense, lazy } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import * as Sentry from '@sentry/react';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { AppConfigProvider, useAppConfig } from './contexts/AppConfigContext';
import { SentryDebug } from './components/SentryDebug';
import { ToastProvider } from './components/ui/Toast';
import { TooltipProvider } from './components/ui/tooltip-base';
import Layout from './components/Layout';
import api from './api/client';

const Setup = lazy(() => import('./pages/Setup'));
const Login = lazy(() => import('./pages/Login'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Bookmarks = lazy(() => import('./pages/Bookmarks'));
const Folders = lazy(() => import('./pages/Folders'));
const Tags = lazy(() => import('./pages/Tags'));
const Profile = lazy(() => import('./pages/Profile'));
const AdminLayout = lazy(() => import('./pages/admin/AdminLayout'));
const AdminMembersPage = lazy(() => import('./pages/admin/AdminMembersPage'));
const AdminTeamsPage = lazy(() => import('./pages/admin/AdminTeamsPage'));
const AdminOIDCPage = lazy(() => import('./pages/admin/AdminOIDCPage'));
const AdminSettingsPage = lazy(() => import('./pages/admin/AdminSettingsPage'));
const AdminAIPage = lazy(() => import('./pages/admin/AdminAIPage'));
const Shared = lazy(() => import('./pages/Shared'));
const PasswordReset = lazy(() => import('./pages/PasswordReset'));
const VerifyEmail = lazy(() => import('./pages/VerifyEmail'));
const SearchEngineGuide = lazy(() => import('./pages/SearchEngineGuide'));
const GoPreferences = lazy(() => import('./pages/GoPreferences'));

function PrivateRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const { t } = useTranslation();
  const { appBasePath } = useAppConfig();
  if (loading) return <div className="min-h-screen flex items-center justify-center"><div className="text-lg">{t('common.loading')}</div></div>;
  if (!user) return <Navigate to={`${appBasePath}/login`} replace />;
  return <>{children}</>;
}

function AdminRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const { t } = useTranslation();
  const { appBasePath, appRootPath } = useAppConfig();
  if (loading) return <div className="min-h-screen flex items-center justify-center"><div className="text-lg">{t('common.loading')}</div></div>;
  if (!user) return <Navigate to={`${appBasePath}/login`} replace />;
  if (!user.is_admin) return <Navigate to={appRootPath} replace />;
  return <>{children}</>;
}

function AppRoutes() {
  const { user, loading } = useAuth();
  const { t } = useTranslation();
  const { appRootPath } = useAppConfig();
  const [setupStatus, setSetupStatus] = React.useState<{ initialized: boolean } | null>(null);
  const [setupLoading, setSetupLoading] = React.useState(true);

  React.useEffect(() => {
    api.get('/auth/setup/status')
      .then((res) => res.data)
      .then((data) => { setSetupStatus(data); setSetupLoading(false); })
      .catch(() => { setSetupStatus({ initialized: true }); setSetupLoading(false); });
  }, []);

  if (setupLoading || (loading && setupStatus?.initialized)) {
    return <div className="min-h-screen flex items-center justify-center"><div className="text-lg">{t('common.loading')}</div></div>;
  }
  if (setupStatus && !setupStatus.initialized) {
    return <Suspense fallback={<div className="min-h-screen flex items-center justify-center"><div className="text-lg">{t('common.loading')}</div></div>}><Setup /></Suspense>;
  }

  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center"><div className="text-lg">{t('common.loading')}</div></div>}>
      <Routes>
        <Route path="/login" element={!user ? <Login /> : <Navigate to={appRootPath} replace />} />
        <Route path="/reset-password" element={<PasswordReset />} />
        <Route path="/password-reset" element={<PasswordReset />} />
        <Route path="/verify-email" element={<VerifyEmail />} />
        <Route path="/go/:slug" element={<ForwardingHandler />} />
        <Route path="/" element={<PrivateRoute><Layout /></PrivateRoute>}>
          <Route index element={<Dashboard />} />
          <Route path="bookmarks" element={<Bookmarks />} />
          <Route path="folders" element={<Folders />} />
          <Route path="tags" element={<Tags />} />
          <Route path="shared" element={<Shared />} />
          <Route path="profile" element={<Profile />} />
          <Route path="go-preferences" element={<GoPreferences />} />
          <Route path="search-engine-guide" element={<SearchEngineGuide />} />
          <Route path="admin" element={<AdminRoute><AdminLayout /></AdminRoute>}>
            <Route index element={<Navigate to="members" replace />} />
            <Route path="members" element={<AdminMembersPage />} />
            <Route path="teams" element={<AdminTeamsPage />} />
            <Route path="oidc" element={<AdminOIDCPage />} />
            <Route path="settings" element={<AdminSettingsPage />} />
            <Route path="ai" element={<AdminAIPage />} />
          </Route>
        </Route>
      </Routes>
    </Suspense>
  );
}

function ForwardingHandler() {
  const location = useLocation();
  const { pathname } = location;
  const { t } = useTranslation();
  const { apiBaseUrl } = useAppConfig();

  React.useEffect(() => {
    const match = pathname.match(/\/go\/([^/]+)/);
    const slug = match ? match[1] : '';
    const goPath = slug ? `/go/${slug}` : '/go';
    const isDevelopment = window.location.hostname === 'localhost';
    const backendUrl = isDevelopment
      ? `http://localhost:5000${goPath}`
      : apiBaseUrl
        ? `${apiBaseUrl}${goPath}`
        : goPath;
    window.location.href = backendUrl;
  }, [pathname, apiBaseUrl]);

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-gray-500 dark:text-gray-400">{t('common.loading')}</div>
    </div>
  );
}

function AppErrorFallback() {
  const { t } = useTranslation();
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-4 p-4">
      <p className="text-lg text-gray-700 dark:text-gray-300">{t('common.error')}</p>
      <button type="button" onClick={() => window.location.reload()} className="px-4 py-2 rounded-md bg-primary text-primary-foreground hover:opacity-90">
        {t('common.reload')}
      </button>
    </div>
  );
}

export interface AppProps {
  /** Base path for app routes (e.g. '/' for self-hosted, '/app' for cloud). */
  basePath?: string;
  /** API base URL (e.g. '' for same-origin, or full URL if frontend is on different origin). */
  apiBaseUrl?: string;
}

function App({ basePath, apiBaseUrl }: AppProps = {}) {
  const appRootPath = basePath === '/' || !basePath ? '/' : basePath;
  return (
    <Sentry.ErrorBoundary fallback={<AppErrorFallback />}>
      <AppConfigProvider appBasePath={basePath} apiBaseUrl={apiBaseUrl} appRootPath={appRootPath}>
        <BrowserRouter basename={basePath ?? ''}>
          <AuthProvider>
            <TooltipProvider>
              <ToastProvider>
                <AppRoutes />
                <SentryDebug />
              </ToastProvider>
            </TooltipProvider>
          </AuthProvider>
        </BrowserRouter>
      </AppConfigProvider>
    </Sentry.ErrorBoundary>
  );
}

export default App;
