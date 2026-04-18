import React, { Suspense, lazy, Component, useMemo, type ReactNode } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { AppConfigProvider, useAppConfig } from './contexts/AppConfigContext';
import {
  PlanProvider,
  usePlan,
  usePlanLoadState,
  showAdminAiNav,
  showAdminMembersNav,
  showAdminTeamsNav,
  showAdminAuditLogNav,
  getFirstAdminRedirectPath,
  isCloudMode,
} from './contexts/PlanContext';
import { ToastProvider } from './components/ui/Toast';
import { TooltipProvider } from './components/ui/tooltip-base';
import Layout from './components/Layout';
import api from './api/client';
import { canAccessWorkspaceAdmin } from './utils/adminAccess';
import { absoluteUrlForGoPath } from './utils/goRedirectUrl';
import { authShell, authCard } from './components/auth/authPageClasses';
import { AlertCircle } from 'lucide-react';
import { cn } from './lib/utils';

const Setup = lazy(() => import('./pages/Setup'));
import Login from './pages/Login';
import MfaChallenge from './pages/MfaChallenge';
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
const AdminAuditLogPage = lazy(() => import('./pages/admin/AdminAuditLogPage'));
const PasswordReset = lazy(() => import('./pages/PasswordReset'));
const VerifyEmail = lazy(() => import('./pages/VerifyEmail'));
const VerifyEmailRequired = lazy(() => import('./pages/VerifyEmailRequired'));
const SearchEngineGuide = lazy(() => import('./pages/SearchEngineGuide'));
const GoPreferences = lazy(() => import('./pages/GoPreferences'));
const NotFound = lazy(() => import('./pages/NotFound'));

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
  if (!canAccessWorkspaceAdmin(user)) return <Navigate to={appRootPath} replace />;
  return <>{children}</>;
}

/** Redirect /admin to first visible admin tab. */
function AdminIndexRedirect() {
  const planInfo = usePlan();
  const planLoadState = usePlanLoadState();
  const { extraAdminNavItems, hideAdminOidcAndSmtp } = useAppConfig();
  const firstPath = getFirstAdminRedirectPath(planInfo, planLoadState, {
    hideAdminOidcAndSmtp: !!hideAdminOidcAndSmtp,
    extraAdminNavItems,
  });
  return <Navigate to={firstPath} replace />;
}

/** In cloud, /admin/ai is only available on personal/team/supporter; otherwise redirect to first admin tab. */
function AdminAIGate() {
  const planInfo = usePlan();
  const planLoadState = usePlanLoadState();
  const { extraAdminNavItems, hideAdminOidcAndSmtp } = useAppConfig();
  const showAi = showAdminAiNav(planInfo);
  if (!showAi) {
    const firstPath = getFirstAdminRedirectPath(planInfo, planLoadState, {
      hideAdminOidcAndSmtp: !!hideAdminOidcAndSmtp,
      extraAdminNavItems,
    });
    return <Navigate to={firstPath} replace />;
  }
  return <AdminAIPage />;
}

/** In cloud, /admin/teams is only available on Team plan; otherwise redirect. */
function AdminTeamsGate() {
  const planInfo = usePlan();
  const planLoadState = usePlanLoadState();
  const { extraAdminNavItems, hideAdminOidcAndSmtp } = useAppConfig();
  if (isCloudMode && !showAdminTeamsNav(planInfo, planLoadState)) {
    const firstPath = getFirstAdminRedirectPath(planInfo, planLoadState, {
      hideAdminOidcAndSmtp: !!hideAdminOidcAndSmtp,
      extraAdminNavItems,
    });
    return <Navigate to={firstPath} replace />;
  }
  return <AdminTeamsPage />;
}

/** Cloud: Team plan + 2+ org members; self-hosted always. */
function AdminAuditLogGate() {
  const planInfo = usePlan();
  const planLoadState = usePlanLoadState();
  const { t } = useTranslation();
  const { extraAdminNavItems, hideAdminOidcAndSmtp } = useAppConfig();
  if (isCloudMode && planLoadState === 'loading') {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <div className="text-lg text-muted-foreground">{t('common.loading')}</div>
      </div>
    );
  }
  if (isCloudMode && !showAdminAuditLogNav(planInfo, planLoadState)) {
    const firstPath = getFirstAdminRedirectPath(planInfo, planLoadState, {
      hideAdminOidcAndSmtp: !!hideAdminOidcAndSmtp,
      extraAdminNavItems,
    });
    return <Navigate to={firstPath} replace />;
  }
  return <AdminAuditLogPage />;
}

/** Cloud: Team plan only; same redirect pattern as Teams. */
function AdminMembersGate() {
  const planInfo = usePlan();
  const planLoadState = usePlanLoadState();
  const { t } = useTranslation();
  const { extraAdminNavItems, hideAdminOidcAndSmtp } = useAppConfig();
  if (isCloudMode && planLoadState === 'loading') {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <div className="text-lg text-muted-foreground">{t('common.loading')}</div>
      </div>
    );
  }
  if (isCloudMode && !showAdminMembersNav(planInfo, planLoadState)) {
    const firstPath = getFirstAdminRedirectPath(planInfo, planLoadState, {
      hideAdminOidcAndSmtp: !!hideAdminOidcAndSmtp,
      extraAdminNavItems,
    });
    return <Navigate to={firstPath} replace />;
  }
  return <AdminMembersPage />;
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

  /** After POST /auth/setup, the server marks initialized but this state was only read once — refetch so we mount Routes instead of staying on Setup. */
  React.useEffect(() => {
    if (skipSetupFlow || setupLoading || !user) return;
    if (setupStatus == null || setupStatus.initialized !== false) return;
    let cancelled = false;
    api
      .get('/auth/setup/status')
      .then((res) => res.data)
      .then((data) => {
        if (!cancelled) setSetupStatus(data);
      })
      .catch(() => {
        if (!cancelled) setSetupStatus({ initialized: true });
      });
    return () => {
      cancelled = true;
    };
  }, [user, skipSetupFlow, setupLoading, setupStatus?.initialized]);

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
        <Route path="/mfa" element={!user ? <LoginRouteErrorBoundary><MfaChallenge /></LoginRouteErrorBoundary> : <Navigate to={appRootPath} replace />} />
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
            <Route path="members" element={<AdminMembersGate />} />
            <Route path="teams" element={<AdminTeamsGate />} />
            <Route path="audit-log" element={<AdminAuditLogGate />} />
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
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </Suspense>
  );
}

function ForwardingHandler() {
  const location = useLocation();
  const { t } = useTranslation();
  const { apiBaseUrl } = useAppConfig();

  const { displayPath, targetUrl } = useMemo(() => {
    const pathname = location.pathname;
    const match = pathname.match(/\/go\/([^/]+)/);
    const rawSegment = match ? match[1] : '';
    let slug = rawSegment;
    if (rawSegment) {
      try {
        slug = decodeURIComponent(rawSegment);
      } catch {
        slug = rawSegment;
      }
    }
    const goPath = rawSegment ? `/go/${encodeURIComponent(slug)}` : '/go';
    return {
      displayPath: goPath,
      targetUrl: absoluteUrlForGoPath(goPath, { apiBaseUrl }),
    };
  }, [location.pathname, apiBaseUrl]);

  React.useEffect(() => {
    window.location.href = targetUrl;
  }, [targetUrl]);

  return (
    <div className={cn(authShell, 'flex min-h-screen flex-col items-center justify-center py-16')}>
      <div className={cn(authCard, 'max-w-[440px] text-center')}>
        <div className="slug-trail mb-4 inline-flex justify-center" aria-hidden>
          <span />
          <span />
          <span />
          <span />
          <span />
          <span />
        </div>
        <p className="font-mono text-[12px] leading-relaxed text-[var(--fg-0)]">
          <span className="text-[var(--accent-hi)]">{displayPath}</span>
          <span className="text-[var(--fg-3)]"> → </span>
          <span className="break-all text-[var(--fg-1)]">{targetUrl}</span>
        </p>
        <p className="mt-4 text-[12.5px] text-[var(--fg-3)]">{t('common.loading')}</p>
      </div>
    </div>
  );
}

interface AppErrorFallbackProps {
  error?: Error | null;
  onReset?: () => void;
}

function AppErrorFallback({ error, onReset }: AppErrorFallbackProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { appRootPath } = useAppConfig();
  const digest = (error as Error & { digest?: string })?.digest;

  return (
    <div className={cn(authShell, 'flex min-h-screen flex-col items-center justify-center px-4 py-16')} role="alert">
      <div className={cn(authCard, 'w-full max-w-[440px]')}>
        <div className="mb-5 flex flex-col items-center text-center">
          <div className="mb-3 grid size-14 place-items-center rounded-2xl border border-[rgba(248,113,113,0.35)] bg-[rgba(248,113,113,0.12)]">
            <AlertCircle className="size-7 text-[var(--danger)]" strokeWidth={2} aria-hidden />
          </div>
          <h2 className="m-0 text-[18px] font-semibold text-[var(--fg-0)]">{t('common.errorTitle')}</h2>
          <p className="mt-2 text-[13px] text-[var(--fg-2)]">
            {t('common.errorBoundaryMessage')}
            {digest ? (
              <span className="mt-2 block font-mono text-[11px] text-[var(--fg-3)]">{String(digest)}</span>
            ) : null}
          </p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          <button
            type="button"
            onClick={() => (onReset ? onReset() : window.location.reload())}
            className="inline-flex items-center justify-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--accent-ring)] bg-[var(--accent-bg-hi)] px-4 py-2.5 text-[13px] font-medium text-[var(--accent)] hover:bg-[var(--accent-bg)]"
          >
            {t('common.reload')}
          </button>
          <button
            type="button"
            onClick={() => {
              if (onReset) onReset();
              navigate(appRootPath, { replace: true });
            }}
            className="inline-flex items-center justify-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-3)] px-4 py-2.5 text-[13px] font-medium text-[var(--fg-1)] hover:bg-[var(--bg-2)]"
          >
            {t('common.backToDashboard')}
          </button>
        </div>
      </div>
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
  /** With `signupPrivacyUrl`, enables signup legal checkbox (e.g. cloud `/terms`). Omit both for self-hosted. */
  signupTermsUrl?: string;
  /** With `signupTermsUrl`, enables signup legal checkbox (e.g. cloud `/privacy`). Omit both for self-hosted. */
  signupPrivacyUrl?: string;
}

function App({ basePath, apiBaseUrl, routerBasename, skipSetupFlow, hideAdminOidcAndSmtp, adminAiOnlyToggle, extraAdminRoutes, extraAdminNavItems, profileDeleteGuard, signupTermsUrl, signupPrivacyUrl }: AppProps = {}) {
  const appRootPath = routerBasename !== undefined ? '/' : (basePath === '/' || !basePath ? '/' : basePath);
  const pathPrefixForLinks = routerBasename !== undefined ? '' : (basePath ?? '');
  const routes = (
    <AppErrorBoundary>
      <AuthProvider>
        <PlanProvider>
          <TooltipProvider>
            <ToastProvider>
              <AppRoutes />
            </ToastProvider>
          </TooltipProvider>
        </PlanProvider>
      </AuthProvider>
    </AppErrorBoundary>
  );
  return (
    <AppConfigProvider appBasePath={basePath} apiBaseUrl={apiBaseUrl} appRootPath={appRootPath} skipSetupFlow={skipSetupFlow} pathPrefixForLinks={pathPrefixForLinks} hideAdminOidcAndSmtp={hideAdminOidcAndSmtp} adminAiOnlyToggle={adminAiOnlyToggle} extraAdminNavItems={extraAdminNavItems} extraAdminRoutes={extraAdminRoutes} profileDeleteGuard={profileDeleteGuard} signupTermsUrl={signupTermsUrl} signupPrivacyUrl={signupPrivacyUrl}>
      {routerBasename !== undefined ? routes : <BrowserRouter basename={basePath ?? ''}>{routes}</BrowserRouter>}
    </AppConfigProvider>
  );
}

export default App;
