import React, { Suspense, lazy } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation, Outlet } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import * as Sentry from '@sentry/react';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { SentryDebug } from './components/SentryDebug';
import { OrgPlanProvider } from './contexts/OrgPlanContext';
import { ToastProvider } from './components/ui/Toast';
import { TooltipProvider } from './components/ui/tooltip-base';
import Layout from './components/Layout';
import api from './api/client';
import { isCloud } from './config/mode';
import { apiBaseUrl } from './config/api';

// Lazy load pages for code splitting
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
const AdminBillingPage = lazy(() => import('./pages/admin/AdminBillingPage'));
const AdminOIDCPage = lazy(() => import('./pages/admin/AdminOIDCPage'));
const AdminSettingsPage = lazy(() => import('./pages/admin/AdminSettingsPage'));
const AdminAIPage = lazy(() => import('./pages/admin/AdminAIPage'));
const Shared = lazy(() => import('./pages/Shared'));
const PasswordReset = lazy(() => import('./pages/PasswordReset'));
const VerifyEmail = lazy(() => import('./pages/VerifyEmail'));
const Signup = lazy(() => import('./pages/Signup'));
const AcceptInvite = lazy(() => import('./pages/AcceptInvite'));
const SearchEngineGuide = lazy(() => import('./pages/SearchEngineGuide'));
const GoPreferences = lazy(() => import('./pages/GoPreferences'));
const Landing = lazy(() => import('./pages/landing/Landing'));
const Pricing = lazy(() => import('./pages/landing/Pricing'));
const Contact = lazy(() => import('./pages/landing/Contact'));
const Terms = lazy(() => import('./pages/landing/Terms'));
const Privacy = lazy(() => import('./pages/landing/Privacy'));
const Imprint = lazy(() => import('./pages/landing/Imprint'));

const loginPath = () => (isCloud ? '/app/login' : '/login');
const appRootPath = () => (isCloud ? '/app' : '/');

function PrivateRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const { t } = useTranslation();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-lg">{t('common.loading')}</div>
      </div>
    );
  }

  if (!user) {
    return <Navigate to={loginPath()} replace />;
  }

  return <>{children}</>;
}

function AdminRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const { t } = useTranslation();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-lg">{t('common.loading')}</div>
      </div>
    );
  }

  if (!user) {
    return <Navigate to={loginPath()} replace />;
  }

  const canAccessAdmin = user.is_admin || (isCloud && (user.org_role === 'owner' || user.org_role === 'admin'));
  if (!canAccessAdmin) {
    return <Navigate to={appRootPath()} replace />;
  }

  return <>{children}</>;
}

function AppGate({ children }: { children: React.ReactNode }) {
  const { loading } = useAuth();
  const { t } = useTranslation();
  const [setupStatus, setSetupStatus] = React.useState<{ initialized: boolean } | null>(null);
  const [setupLoading, setSetupLoading] = React.useState(true);

  React.useEffect(() => {
    api.get('/auth/setup/status')
      .then((res) => res.data)
      .then((data) => {
        setSetupStatus(data);
        setSetupLoading(false);
      })
      .catch((error) => {
        console.error('Error checking setup status:', error);
        setSetupStatus({ initialized: true });
        setSetupLoading(false);
      });
  }, []);

  if (setupLoading || (loading && setupStatus?.initialized)) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-lg">{t('common.loading')}</div>
      </div>
    );
  }
  if (setupStatus && !setupStatus.initialized && !isCloud) {
    return (
      <Suspense fallback={<div className="min-h-screen flex items-center justify-center"><div className="text-lg">{t('common.loading')}</div></div>}>
        <Setup />
      </Suspense>
    );
  }
  return <>{children}</>;
}

function AppRoutesSelfhosted() {
  const { user, loading } = useAuth();
  const { t } = useTranslation();
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
        <Route path="/login" element={!user ? <Login /> : <Navigate to="/" replace />} />
        <Route path="/contact" element={!user ? <Contact /> : <Navigate to="/" replace />} />
        <Route path="/reset-password" element={<PasswordReset />} />
        <Route path="/password-reset" element={<PasswordReset />} />
        <Route path="/verify-email" element={<VerifyEmail />} />
        <Route path="/go/:slug" element={<ForwardingHandler />} />
        <Route path="/" element={<PrivateRoute><OrgPlanProvider><Layout /></OrgPlanProvider></PrivateRoute>}>
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

function AppRoutesCloud() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center"><div className="text-lg">Loading...</div></div>}>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/pricing" element={<Pricing />} />
        <Route path="/contact" element={<Contact />} />
        <Route path="/terms" element={<Terms />} />
        <Route path="/privacy" element={<Privacy />} />
        <Route path="/imprint" element={<Imprint />} />
        <Route path="/app" element={<AppGate><Outlet /></AppGate>}>
          <Route path="login" element={<Login />} />
          <Route path="signup" element={<Signup />} />
          <Route path="reset-password" element={<PasswordReset />} />
          <Route path="password-reset" element={<PasswordReset />} />
          <Route path="verify-email" element={<VerifyEmail />} />
          <Route path="accept-invite" element={<AcceptInvite />} />
          <Route path="go/:slug" element={<ForwardingHandler />} />
          <Route path="" element={<PrivateRoute><OrgPlanProvider><Layout /></OrgPlanProvider></PrivateRoute>}>
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
              <Route path="billing" element={<AdminBillingPage />} />
            </Route>
          </Route>
        </Route>
      </Routes>
    </Suspense>
  );
}

function AppRoutes() {
  if (isCloud) return <AppRoutesCloud />;
  return <AppRoutesSelfhosted />;
}

// Component to handle forwarding URLs - redirects to backend /go endpoint
function ForwardingHandler() {
  const location = useLocation();
  const { pathname } = location;
  const { t } = useTranslation();

  React.useEffect(() => {
    // Extract slug from pathname: /go/:slug or /app/go/:slug (cloud)
    const match = pathname.match(/\/go\/([^/]+)/);
    const slug = match ? match[1] : '';
    const goPath = slug ? `/go/${slug}` : '/go';
    // In development, redirect to backend (port 5000)
    // In CLOUD mode, use API URL for /go (backend is on different origin)
    // In production selfhosted, same origin
    const isDevelopment = window.location.hostname === 'localhost';
    const backendUrl = isDevelopment
      ? `http://localhost:5000${goPath}`
      : apiBaseUrl
        ? `${apiBaseUrl}${goPath}`
        : goPath;
    window.location.href = backendUrl;
  }, [pathname]);

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
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="px-4 py-2 rounded-md bg-primary text-primary-foreground hover:opacity-90"
      >
        {t('common.reload')}
      </button>
    </div>
  );
}

function App() {
  return (
    <Sentry.ErrorBoundary fallback={<AppErrorFallback />}>
      <BrowserRouter>
        <AuthProvider>
          <TooltipProvider>
            <ToastProvider>
              <AppRoutes />
              <SentryDebug />
            </ToastProvider>
          </TooltipProvider>
        </AuthProvider>
      </BrowserRouter>
    </Sentry.ErrorBoundary>
  );
}

export default App;
