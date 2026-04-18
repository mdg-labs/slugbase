import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useAppConfig } from '../contexts/AppConfigContext';
import api from '../api/client';
import { getAuthProviderUrl } from '../config/api';
import { ArrowRight, Eye, EyeOff, Lock, Mail } from 'lucide-react';
import { cn } from '../lib/utils';
import { AuthSplitLayout } from '../components/auth/AuthSplitLayout';
import {
  authTitle,
  authSub,
  oauthRow,
  dividerLbl,
  authField,
  authFieldLabel,
  authInput,
  fieldError,
  authSubmit,
} from '../components/auth/authPageClasses';
import { safeRedirectPath } from '../utils/safeRedirectPath';
import {
  OidcProviderSignInButton,
  formatOidcProviderDisplayName,
} from '../components/auth/OidcProviderSignInButton';

export default function Login() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user, checkAuth } = useAuth();
  const { pathPrefixForLinks } = useAppConfig();
  const prefix = (pathPrefixForLinks || '').replace(/\/+/g, '/') || '';
  const signupHref = `${prefix}/signup`.replace(/\/+/g, '/') || '/signup';
  const loginPath = `${prefix}/login`.replace(/\/+/g, '/') || '/login';
  const passwordResetHref = `${prefix}/password-reset`.replace(/\/+/g, '/') || '/password-reset';
  const [providers, setProviders] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [localAuth, setLocalAuth] = useState({
    email: '',
    password: '',
  });
  const [localLoading, setLocalLoading] = useState(false);
  const [error, setError] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    if (user) {
      const redirectTo = searchParams.get('redirect');
      const safePath = safeRedirectPath(redirectTo);
      navigate(safePath || '/', { replace: true });
    }
  }, [user, navigate, searchParams]);

  useEffect(() => {
    const errorParam = searchParams.get('error');
    if (errorParam) {
      if (errorParam === 'auth_failed') {
        setError(t('auth.oidcAuthFailed'));
      } else if (errorParam === 'auto_create_disabled') {
        setError(t('auth.oidcAutoCreateDisabled'));
      } else {
        setError(t('auth.loginFailed'));
      }
      searchParams.delete('error');
      setSearchParams(searchParams, { replace: true });
    }
  }, [searchParams, setSearchParams, t]);

  useEffect(() => {
    api
      .get('/auth/providers')
      .then((res) => setProviders(res.data))
      .catch(() => setProviders([]))
      .finally(() => setLoading(false));
  }, []);

  const handleOIDCLogin = (providerKey: string) => {
    window.location.href = getAuthProviderUrl(providerKey);
  };

  const handleLocalLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalLoading(true);
    setError('');

    try {
      const res = await api.post('/auth/login', localAuth);
      if (res.data?.mfa_required === true) {
        const redirectTo = searchParams.get('redirect');
        const safePath = safeRedirectPath(redirectTo);
        const mfaPath = `${prefix}/mfa`.replace(/\/+/g, '/') || '/mfa';
        const qs = safePath ? `?redirect=${encodeURIComponent(safePath)}` : '';
        navigate(`${mfaPath}${qs}`, { replace: true });
        return;
      }
      await checkAuth();
      const redirectTo = searchParams.get('redirect');
      const safePath = safeRedirectPath(redirectTo);
      navigate(safePath || '/', { replace: true });
    } catch (err: any) {
      const code = err.response?.data?.code;
      const message = err.response?.data?.error;
      if (code === 'EMAIL_NOT_VERIFIED') {
        const verifyPath =
          `${prefix}/verify-email-required`.replace(/\/+/g, '/') || '/verify-email-required';
        navigate(verifyPath, { replace: true, state: { email: localAuth.email } });
        return;
      }
      setError(message || t('auth.loginFailed'));
    } finally {
      setLocalLoading(false);
    }
  };

  const showOidcBlock = !loading && providers.length > 0;

  return (
    <AuthSplitLayout
      activeTab="signin"
      showTabs
      onTabChange={(tab) => navigate(tab === 'signup' ? signupHref : loginPath, { replace: true })}
    >
      <form onSubmit={handleLocalLogin} className="flex flex-col">
        <div className="mb-8">
          <h1 className={authTitle}>{t('auth.loginTitle')}</h1>
          <p className={authSub}>
            {t('signup.noAccount')}{' '}
            <Link to={signupHref} className="font-medium text-[var(--accent-hi)] hover:underline">
              {t('auth.signUp')}
            </Link>
          </p>
        </div>

        {showOidcBlock ? (
          <>
            <div className={oauthRow}>
              {providers.map((provider) => (
                <OidcProviderSignInButton
                  key={provider.id}
                  providerKey={provider.provider_key}
                  label={t('auth.loginWith', {
                    provider: formatOidcProviderDisplayName(provider.provider_key),
                  })}
                  onClick={() => handleOIDCLogin(provider.provider_key)}
                />
              ))}
            </div>
            <div className={dividerLbl}>{t('auth.orEmail')}</div>
          </>
        ) : null}

        <div className="flex flex-col gap-5">
          <div className={authField}>
            <label htmlFor="email" className={authFieldLabel}>
              {t('auth.email')}
            </label>
            <div className={cn(authInput)}>
              <Mail className="h-4 w-4 shrink-0 text-[var(--fg-3)]" aria-hidden />
              <input
                id="email"
                name="email"
                type="email"
                required
                placeholder={t('auth.emailPlaceholder')}
                value={localAuth.email}
                onChange={(e) => setLocalAuth({ ...localAuth, email: e.target.value })}
                autoComplete="email"
                className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] text-[var(--fg-0)] outline-none placeholder:text-[var(--fg-4)]"
              />
            </div>
          </div>

          <div className={authField}>
            <div className="flex items-center justify-between gap-2">
              <label htmlFor="password" className={authFieldLabel}>
                {t('auth.password')}
              </label>
              <Link
                to={passwordResetHref}
                className="font-mono text-[10px] font-medium uppercase tracking-wide text-[var(--accent-hi)] hover:underline"
              >
                {t('auth.forgotPassword')}
              </Link>
            </div>
            <div className={cn(authInput)}>
              <Lock className="h-4 w-4 shrink-0 text-[var(--fg-3)]" aria-hidden/>
              <input
                id="password"
                name="password"
                type={showPassword ? 'text' : 'password'}
                required
                placeholder={t('auth.passwordPlaceholder')}
                value={localAuth.password}
                onChange={(e) => setLocalAuth({ ...localAuth, password: e.target.value })}
                autoComplete="current-password"
                className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] text-[var(--fg-0)] outline-none placeholder:text-[var(--fg-4)]"
              />
              <button
                type="button"
                className="shrink-0 rounded p-1 text-[var(--fg-3)] hover:text-[var(--fg-0)]"
                onClick={() => setShowPassword((v) => !v)}
                aria-pressed={showPassword}
                aria-label={showPassword ? t('auth.hidePassword') : t('auth.showPassword')}
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          {error ? (
            <p className={cn(fieldError, 'rounded-md border border-[rgba(248,113,113,0.35)] bg-[rgba(248,113,113,0.08)] px-3 py-2')} role="alert">
              {error}
            </p>
          ) : null}

          <button type="submit" disabled={localLoading} className={authSubmit}>
            <span>{localLoading ? t('common.loading') : t('auth.signInButton')}</span>
            <ArrowRight className="h-4 w-4 shrink-0 opacity-90" aria-hidden />
          </button>
        </div>
      </form>
    </AuthSplitLayout>
  );
}
