import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import api from '../api/client';
import { getAuthProviderUrl } from '../config/api';
import { isCloud } from '../config/mode';
import { LogIn, Key } from 'lucide-react';
import Button from '../components/ui/Button';

export default function Login() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();
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
      navigate(safePath || (isCloud ? '/app' : '/'), { replace: true });
    }
  }, [user, navigate, searchParams]);

  useEffect(() => {
    // Check for OIDC error in URL query parameters
    const errorParam = searchParams.get('error');
    if (errorParam) {
      if (errorParam === 'auth_failed') {
        setError(t('auth.oidcAuthFailed'));
      } else if (errorParam === 'auto_create_disabled') {
        setError(t('auth.oidcAutoCreateDisabled'));
      } else {
        setError(t('auth.loginFailed'));
      }
      // Remove error from URL
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
      window.location.href = safePath || (isCloud ? '/app' : '/');
    } catch (err: any) {
      const code = err.response?.data?.code;
      const message = err.response?.data?.error;
      if (code === 'EMAIL_NOT_VERIFIED') {
        setError(t('auth.verifyEmailRequired'));
      } else {
        setError(message || t('auth.loginFailed'));
      }
    } finally {
      setLocalLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-md w-full space-y-8">
        <div className="text-center">
          <div className="flex justify-center mb-6">
            <img 
              src="/slugbase_icon_blue.svg" 
              alt="SlugBase" 
              className="h-16 w-16 dark:hidden"
            />
            <img 
              src="/slugbase_icon_white.svg" 
              alt="SlugBase" 
              className="h-16 w-16 hidden dark:block"
            />
          </div>
          <h2 className="text-2xl font-semibold text-gray-900 dark:text-white">
            {t('auth.login')}
          </h2>
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
            {t('app.tagline')}
          </p>
        </div>

        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 shadow-lg p-4 space-y-6">
          {/* Local Authentication Form */}
          <form onSubmit={handleLocalLogin} className="space-y-5">
            <div>
              <label htmlFor="email" className="block text-sm font-semibold text-gray-900 dark:text-white mb-2">
                {t('auth.email')}
              </label>
              <input
                id="email"
                name="email"
                type="email"
                required
                className="w-full px-4 h-9 text-sm text-gray-900 dark:text-white bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-ring focus:border-ring transition-colors"
                placeholder={t('auth.emailPlaceholder')}
                value={localAuth.email}
                onChange={(e) => setLocalAuth({ ...localAuth, email: e.target.value })}
              />
            </div>
            <div>
              <label htmlFor="password" className="block text-sm font-semibold text-gray-900 dark:text-white mb-2">
                {t('auth.password')}
              </label>
              <input
                id="password"
                name="password"
                type="password"
                required
                className="w-full px-4 h-9 text-sm text-gray-900 dark:text-white bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-ring focus:border-ring transition-colors"
                placeholder={t('auth.passwordPlaceholder')}
                value={localAuth.password}
                onChange={(e) => setLocalAuth({ ...localAuth, password: e.target.value })}
              />
            </div>
            {error && (
              <div className="px-4 py-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                <p className="text-sm text-red-800 dark:text-red-200">{error}</p>
              </div>
            )}
            <Button
              type="submit"
              variant="primary"
              disabled={localLoading}
              icon={LogIn}
              className="w-full"
            >
              {localLoading ? t('common.loading') : t('auth.login')}
            </Button>
            <div className="text-center space-y-2">
              <Link
                to={isCloud ? '/app/password-reset' : '/password-reset'}
                className="block text-sm font-medium text-primary hover:text-primary/90"
              >
                {t('auth.forgotPassword')}
              </Link>
              <Link
                to="/contact"
                className="block text-sm font-medium text-primary hover:text-primary/90"
              >
                {t('contact.title')}
              </Link>
              {isCloud && (
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  {t('signup.noAccount')}{' '}
                  <Link to="/app/signup" className="font-medium text-primary hover:underline">
                    {t('auth.signUp')}
                  </Link>
                </p>
              )}
            </div>
          </form>

          {/* OIDC Providers */}
          {!loading && providers.length > 0 && (
            <>
              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-gray-300 dark:border-gray-600"></div>
                </div>
                <div className="relative flex justify-center text-sm">
                  <span className="px-3 bg-white dark:bg-gray-800 text-gray-500 dark:text-gray-400">
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
                    className="w-full"
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
