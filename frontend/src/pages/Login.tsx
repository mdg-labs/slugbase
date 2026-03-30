import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useAppConfig } from '../contexts/AppConfigContext';
import api from '../api/client';
import { getAuthProviderUrl } from '../config/api';
import { LogIn, Key } from 'lucide-react';
import Button from '../components/ui/Button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';

const AUTH_CARD = 'rounded-xl border border-ghost bg-surface p-6 shadow-none';

export default function Login() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();
  const { pathPrefixForLinks } = useAppConfig();
  const prefix = (pathPrefixForLinks || '').replace(/\/+/g, '/') || '';
  const [providers, setProviders] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [localAuth, setLocalAuth] = useState({
    email: '',
    password: '',
  });
  const [localLoading, setLocalLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (user) {
      const redirectTo = searchParams.get('redirect');
      const safePath = redirectTo?.startsWith('/') && !redirectTo.startsWith('//') ? redirectTo : null;
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
    api.get('/auth/providers')
      .then(res => setProviders(res.data))
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
      await api.post('/auth/login', localAuth);
      const redirectTo = searchParams.get('redirect');
      const safePath = redirectTo?.startsWith('/') && !redirectTo.startsWith('//') ? redirectTo : null;
      window.location.href = safePath || '/';
    } catch (err: any) {
      const code = err.response?.data?.code;
      const message = err.response?.data?.error;
      if (code === 'EMAIL_NOT_VERIFIED') {
        const verifyPath = `${prefix}/verify-email-required`.replace(/\/+/g, '/') || '/verify-email-required';
        navigate(verifyPath, { replace: true, state: { email: localAuth.email } });
        return;
      }
      setError(message || t('auth.loginFailed'));
    } finally {
      setLocalLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-md w-full space-y-8">
        <div className="text-center">
          <div className="flex justify-center mb-6">
            <img
              src="/slugbase_icon_purple.svg"
              alt="SlugBase"
              className="h-9 w-9 object-contain"
              width={36}
              height={36}
            />
          </div>
          <h2 className="text-2xl font-semibold text-foreground">
            {t('auth.login')}
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {t('app.tagline')}
          </p>
        </div>

        <div className={AUTH_CARD}>
          <form onSubmit={handleLocalLogin} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="email" className="typography-label">
                {t('auth.email')}
              </Label>
              <Input
                id="email"
                name="email"
                type="email"
                required
                placeholder={t('auth.emailPlaceholder')}
                value={localAuth.email}
                onChange={(e) => setLocalAuth({ ...localAuth, email: e.target.value })}
                autoComplete="email"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password" className="typography-label">
                {t('auth.password')}
              </Label>
              <Input
                id="password"
                name="password"
                type="password"
                required
                placeholder={t('auth.passwordPlaceholder')}
                value={localAuth.password}
                onChange={(e) => setLocalAuth({ ...localAuth, password: e.target.value })}
                autoComplete="current-password"
              />
            </div>
            {error && (
              <div className="px-4 py-3 rounded-xl border border-destructive/30 bg-destructive/10">
                <p className="text-sm text-destructive">{error}</p>
              </div>
            )}
            <Button
              type="submit"
              variant="primary"
              disabled={localLoading}
              icon={LogIn}
              className="w-full border-0 bg-primary-gradient text-primary-foreground shadow-glow hover:opacity-90"
            >
              {localLoading ? t('common.loading') : t('auth.login')}
            </Button>
            <div className="text-center space-y-2">
              <Link
                to={`${prefix}/password-reset`.replace(/\/+/g, '/') || '/password-reset'}
                className="block text-sm font-medium text-primary hover:text-primary/90"
              >
                {t('auth.forgotPassword')}
              </Link>
            </div>
          </form>

          {!loading && providers.length > 0 && (
            <>
              <div className="relative my-6">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-ghost" />
                </div>
                <div className="relative flex justify-center text-sm">
                  <span className="px-3 bg-surface text-muted-foreground typography-label">
                    {t('auth.or')}
                  </span>
                </div>
              </div>
              <div className="space-y-3">
                {providers.map((provider) => (
                  <Button
                    key={provider.id}
                    variant="secondary"
                    icon={Key}
                    onClick={() => handleOIDCLogin(provider.provider_key)}
                    className="w-full border-ghost bg-surface-high"
                  >
                    {t('auth.loginWith', { provider: provider.provider_key })}
                  </Button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
