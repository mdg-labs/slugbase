import React, { Suspense, lazy, Component, type ReactNode } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { AppConfigProvider, useAppConfig } from './contexts/AppConfigContext';
import { PlanProvider, usePlan, showAdminAiNav } from './contexts/PlanContext';
import { ToastProvider } from './components/ui/Toast';
import { TooltipProvider } from './components/ui/tooltip-base';
import Layout from './components/Layout';
import api from './api/client';

const Setup = lazy(() => import('./pages/Setup'));
import Login from './pages/Login';
const Signup = lazy(() => import('./pages/Signup'));
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
const PasswordReset = lazy(() => import('./pages/PasswordReset'));
const VerifyEmail = lazy(() => import('./pages/VerifyEmail'));
const VerifyEmailRequired = lazy(() => import('./pages/VerifyEmailRequired'));
const SearchEngineGuide = lazy(() => import('./pages/SearchEngineGuide'));
const GoPreferences = lazy(() => import('./pages/GoPreferences'));

function PrivateRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const { t } = useTranslation();
  const { pathPrefixForLinks } = useAppConfig();
  const loginPath = `${pathPrefixForLinks || ''}/login`.replace(/\/+/g, '/') || '/login';
  if (loading) return <div className="min-h-screen flex items-center justify-center"><div className="text-lg">{t('common.loading')}</div></div>;
  if (!user) return <Navigate to={loginPath} replace />;
  return <>{children}</>;
}

function AdminRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const { t } = useTranslation();
  const { pathPrefixForLinks, appRootPath } = useAppConfig();
  const loginPath = `${pathPrefixForLinks || ''}/login`.replace(/\/+/g, '/') || '/login';
  if (loading) return <div className="min-h-screen flex items-center justify-center"><div className="text-lg">{t('common.loading')}</div></div>;
  if (!user) return <Navigate to={loginPath} replace />;
  if (!user.is_admin) return <Navigate to={appRootPath} replace />;
  return <>{children}</>;
}

/** Redirect /admin to first visible admin tab (e.g. in cloud free plan, Users/Teams and AI may be hidden so redirect to ai, billing, or members). */
function AdminIndexRedirect() {
  const planInfo = usePlan();
  const { extraAdminNavItems } = useAppConfig();
  const showUsersAndTeams = !planInfo || planInfo.canShareWithTeams;
  const showAi = showAdminAiNav(planInfo);
  const firstPath = showUsersAndTeams
    ? 'members'
    : showAi
      ? 'ai'
      : (extraAdminNavItems?.[0]?.path ?? 'ai');
  return <Navigate to={firstPath} replace />;
}

/** In cloud, /admin/ai is only available on personal/team/supporter; otherwise redirect to first admin tab. */
function AdminAIGate() {
  const planInfo = usePlan();
  const { extraAdminNavItems } = useAppConfig();
  const showAi = showAdminAiNav(planInfo);
  if (!showAi) {
    const showUsersAndTeams = !planInfo || planInfo.canShareWithTeams;
    const firstPath = showUsersAndTeams ? 'members' : (extraAdminNavItems?.[0]?.path ?? 'ai');
    return <Navigate to={firstPath} replace />;
  }
  return <AdminAIPage />;
}

/** Diagnostic: catches errors in login subtree and rethrows with a prefix so cloud boundary shows where the throw came from. */
class LoginRouteErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(raw: unknown): { error: Error } {
    const msg = raw instanceof Error ? raw.message : String(raw);
    return { error: new Error(`[LoginRoute] ${msg || '(no message)'}`) };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    console.error('[Login route boundary]', error, info.componentStack);
  }

  render() {
    if (this.state.error != null) throw this.state.error;
    return this.props.children;
  }
}

function AppRoutes() {
  const { user, loading } = useAuth();
  const { t } = useTranslation();
  const { appRootPath, skipSetupFlow, hideAdminOidcAndSmtp, extraAdminRoutes } = useAppConfig();
  const [setupStatus, setSetupStatus] = React.useState<{ initialized: boolean } | null>(() =>
    skipSetupFlow ? { initialized: true } : null
  );
  const [setupLoading, setSetupLoading] = React.useState(() => !skipSetupFlow);

  React.useEffect(() => {
    if (skipSetupFlow) {
      setSetupLoading(false);
      return;
    }
    api.get('/auth/setup/status')
      .then((res) => res.data)
      .then((data) => { setSetupStatus(data); setSetupLoading(false); })
      .catch(() => { setSetupStatus({ initialized: true }); setSetupLoading(false); });
  }, [skipSetupFlow]);

  if (setupLoading || (loading && setupStatus?.initialized)) {
    return <div className="min-h-screen flex items-center justify-center"><div className="text-lg">{t('common.loading')}</div></div>;
  }
  if (setupStatus && !setupStatus.initialized) {
    return <Suspense fallback={<div className="min-h-screen flex items-center justify-center"><div className="text-lg">{t('common.loading')}</div></div>}><Setup /></Suspense>;
  }

  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center"><div className="text-lg">{t('common.loading')}</div></div>}>
      <Routes>
        <Route path="/login" element={!user ? <LoginRouteErrorBoundary><Login /></LoginRouteErrorBoundary> : <Navigate to={appRootPath} replace />} />
        <Route path="/signup" element={!user ? <Signup /> : <Navigate to={appRootPath} replace />} />
        <Route path="/reset-password" element={<PasswordReset />} />
        <Route path="/password-reset" element={<PasswordReset />} />
        <Route path="/verify-email" element={<VerifyEmail />} />
        <Route path="/verify-email-required" element={<VerifyEmailRequired />} />
        <Route path="/go/:slug" element={<ForwardingHandler />} />
        <Route path="/" element={<PrivateRoute><Layout /></PrivateRoute>}>
          <Route index element={<Dashboard />} />
          <Route path="bookmarks" element={<Bookmarks />} />
          <Route path="folders" element={<Folders />} />
          <Route path="tags" element={<Tags />} />
          <Route path="profile" element={<Profile />} />
          <Route path="go-preferences" element={<GoPreferences />} />
          <Route path="search-engine-guide" element={<SearchEngineGuide />} />
          <Route path="admin" element={<AdminRoute><AdminLayout /></AdminRoute>}>
            <Route index element={<AdminIndexRedirect />} />
            <Route path="members" element={<AdminMembersPage />} />
            <Route path="teams" element={<AdminTeamsPage />} />
            {hideAdminOidcAndSmtp ? (
              <>
                <Route path="oidc" element={<Navigate to="members" replace />} />
                <Route path="settings" element={<Navigate to="members" replace />} />
              </>
            ) : (
              <>
                <Route path="oidc" element={<AdminOIDCPage />} />
                <Route path="settings" element={<AdminSettingsPage />} />
              </>
            )}
            <Route path="ai" element={<AdminAIGate />} />
            {extraAdminRoutes?.map(({ path, element }) => (
              <Route key={path} path={path} element={element} />
            ))}
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
      <div className="text-muted-foreground">{t('common.loading')}</div>
    </div>
  );
}

interface AppErrorFallbackProps {
  error?: Error | null;
  onReset?: () => void;
}

function AppErrorFallback({ error, onReset }: AppErrorFallbackProps) {
  // Use hardcoded strings so this fallback never throws (e.g. when i18n context is missing in embedded host).
  const message = error?.message ?? (error != null ? String(error) : '');
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-4 p-4" role="alert">
      <p className="text-lg text-foreground text-center">
        Something went wrong loading this page. Please try again.
      </p>
      {(message || error?.stack) && (
        <details className="w-full max-w-md text-sm text-muted-foreground" open>
          <summary className="cursor-pointer">{message || 'Error details'}</summary>
          {error?.stack && <pre className="mt-2 overflow-auto whitespace-pre-wrap">{error.stack}</pre>}
        </details>
      )}
      <button
        type="button"
        onClick={() => (onReset ? onReset() : window.location.reload())}
        className="px-4 py-2 rounded-md bg-primary text-primary-foreground hover:opacity-90"
      >
        Reload
      </button>
    </div>
  );
}

interface AppErrorBoundaryState {
  error: Error | null;
}

class AppErrorBoundary extends Component<{ children: ReactNode }, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
    const normalized =
      error instanceof Error ? error : new Error(error != null ? String(error) : 'Unknown error');
    return { error: normalized };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    console.error('App error boundary caught:', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <AppErrorFallback
          error={this.state.error}
          onReset={() => this.setState({ error: null })}
        />
      );
    }
    return this.props.children;
  }
}

export interface AppProps {
  /** Base path for app routes (e.g. '/' for self-hosted, '/app' for cloud). */
  basePath?: string;
  /** API base URL (e.g. '' for same-origin, or full URL if frontend is on different origin). */
  apiBaseUrl?: string;
  /** When set (e.g. "" or null), core does not render BrowserRouter; host (e.g. cloud) provides it. */
  routerBasename?: string | null;
  /** When true, skip the first-time setup flow (e.g. in cloud; first user registers via Signup). */
  skipSetupFlow?: boolean;
  /** When true, hide Admin OIDC and SMTP/Settings (e.g. cloud uses Postmark and global OIDC). */
  hideAdminOidcAndSmtp?: boolean;
  /** When true, Admin AI page shows only the enable/disable toggle (e.g. cloud uses env for provider/model/key). */
  adminAiOnlyToggle?: boolean;
  /** Optional extra admin routes (e.g. cloud billing). Generic extension; path is segment under /admin. */
  extraAdminRoutes?: { path: string; element: ReactNode }[];
  /** Optional extra admin nav items (e.g. cloud billing). Passed to sidebar when extraAdminRoutes are used. */
  extraAdminNavItems?: { path: string; label: string }[];
  /** Optional guard for profile/account deletion (e.g. cloud blocks billing owner). */
  profileDeleteGuard?: () => Promise<{ allowed: boolean; message?: string }>;
}

function App({ basePath, apiBaseUrl, routerBasename, skipSetupFlow, hideAdminOidcAndSmtp, adminAiOnlyToggle, extraAdminRoutes, extraAdminNavItems, profileDeleteGuard }: AppProps = {}) {
  const appRootPath = routerBasename !== undefined ? '/' : (basePath === '/' || !basePath ? '/' : basePath);
  const pathPrefixForLinks = routerBasename !== undefined ? '' : (basePath ?? '');
  const content = (
    <AuthProvider>
      <PlanProvider>
        <TooltipProvider>
          <ToastProvider>
            <AppRoutes />
          </ToastProvider>
        </TooltipProvider>
      </PlanProvider>
    </AuthProvider>
  );
  return (
    <AppErrorBoundary>
      <AppConfigProvider appBasePath={basePath} apiBaseUrl={apiBaseUrl} appRootPath={appRootPath} skipSetupFlow={skipSetupFlow} pathPrefixForLinks={pathPrefixForLinks} hideAdminOidcAndSmtp={hideAdminOidcAndSmtp} adminAiOnlyToggle={adminAiOnlyToggle} extraAdminNavItems={extraAdminNavItems} extraAdminRoutes={extraAdminRoutes} profileDeleteGuard={profileDeleteGuard}>
        {routerBasename !== undefined ? (
          content
        ) : (
          <BrowserRouter basename={basePath ?? ''}>
            {content}
          </BrowserRouter>
        )}
      </AppConfigProvider>
    </AppErrorBoundary>
  );
}

export default App;
