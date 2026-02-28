import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, Link } from 'react-router-dom';
import { useAppConfig } from '../contexts/AppConfigContext';
import api from '../api/client';
import { Mail } from 'lucide-react';
import Button from '../components/ui/Button';

export default function VerifyEmailRequired() {
  const { t } = useTranslation();
  const location = useLocation();
  const { pathPrefixForLinks } = useAppConfig();
  const stateEmail = (location.state as { email?: string } | null)?.email?.trim() || '';
  const [email, setEmail] = useState(stateEmail);
  const [newEmail, setNewEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [emailChanged, setEmailChanged] = useState(false);

  const prefix = pathPrefixForLinks || '';
  const loginPath = `${prefix}/login`.replace(/\/+/g, '/') || '/login';
  const currentEmail = stateEmail || email.trim();

  const handleResend = async (e: React.FormEvent) => {
    e.preventDefault();
    const toSend = currentEmail || email.trim();
    if (!toSend) {
      setError(t('auth.verifyEmailRequiredPageEmailLabel') + ' is required');
      return;
    }
    setLoading(true);
    setError('');
    setSuccess(false);
    setEmailChanged(false);
    try {
      const payload: { email: string; newEmail?: string } = { email: toSend };
      const newEmailTrimmed = newEmail.trim();
      if (newEmailTrimmed && newEmailTrimmed !== toSend) {
        payload.newEmail = newEmailTrimmed;
      }
      const res = await api.post('/auth/request-signup-resend', payload);
      setSuccess(true);
      setEmailChanged(Boolean((res.data as { emailChanged?: boolean })?.emailChanged));
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(msg || t('common.error'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-md w-full space-y-8">
        <div className="text-center">
          <div className="flex justify-center mb-6">
            <img
              src={`/slugbase_icon_blue.svg${(import.meta as any).env?.VITE_ASSET_VERSION ? `?v=${(import.meta as any).env.VITE_ASSET_VERSION}` : ''}`}
              alt="SlugBase"
              className="h-16 w-16 dark:hidden"
            />
            <img
              src={`/slugbase_icon_white.svg${(import.meta as any).env?.VITE_ASSET_VERSION ? `?v=${(import.meta as any).env.VITE_ASSET_VERSION}` : ''}`}
              alt="SlugBase"
              className="h-16 w-16 hidden dark:block"
            />
          </div>
          <h2 className="text-2xl font-semibold text-gray-900 dark:text-white">
            {t('auth.verifyEmailRequiredPageTitle')}
          </h2>
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
            {t('auth.verifyEmailRequiredPageDescription')}
          </p>
        </div>

        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 shadow-lg p-4 space-y-6">
          {success ? (
            <div className="space-y-4 text-center">
              <div className="mx-auto w-16 h-16 bg-green-100 dark:bg-green-900/30 rounded-full flex items-center justify-center">
                <Mail className="h-8 w-8 text-green-600 dark:text-green-400" />
              </div>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                {emailChanged ? t('auth.emailChangedResendMessage') : t('auth.resendVerificationSuccess')}
              </p>
              <Link
                to={loginPath}
                className="inline-block text-sm font-medium text-primary hover:underline"
              >
                {t('signup.backToLogin')}
              </Link>
            </div>
          ) : (
            <form onSubmit={handleResend} className="space-y-5">
              {stateEmail ? (
                <>
                  <p className="text-sm text-gray-600 dark:text-gray-400">
                    {t('auth.verifyEmailRequiredPageEmailLabel')}: <span className="font-medium text-gray-900 dark:text-white">{stateEmail}</span>
                  </p>
                  <div>
                    <label htmlFor="verify-email-required-new-email" className="block text-sm font-semibold text-gray-900 dark:text-white mb-2">
                      {t('auth.newEmailLabel')}
                    </label>
                    <input
                      id="verify-email-required-new-email"
                      name="newEmail"
                      type="email"
                      className="w-full px-4 h-9 text-sm text-gray-900 dark:text-white bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-ring focus:border-ring transition-colors"
                      placeholder={t('auth.newEmailPlaceholder')}
                      value={newEmail}
                      onChange={(e) => setNewEmail(e.target.value)}
                    />
                    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                      {t('auth.newEmailHint')}
                    </p>
                  </div>
                </>
              ) : (
                <div>
                  <label htmlFor="verify-email-required-email" className="block text-sm font-semibold text-gray-900 dark:text-white mb-2">
                    {t('auth.verifyEmailRequiredPageEmailLabel')}
                  </label>
                  <input
                    id="verify-email-required-email"
                    name="email"
                    type="email"
                    required
                    className="w-full px-4 h-9 text-sm text-gray-900 dark:text-white bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-ring focus:border-ring transition-colors"
                    placeholder={t('auth.emailPlaceholder')}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </div>
              )}
              {error && (
                <div className="px-4 py-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                  <p className="text-sm text-red-800 dark:text-red-200">{error}</p>
                </div>
              )}
              <Button
                type="submit"
                variant="primary"
                disabled={loading}
                icon={Mail}
                className="w-full"
              >
                {loading ? t('common.loading') : t('auth.resendVerificationEmail')}
              </Button>
              <div className="text-center">
                <Link
                  to={loginPath}
                  className="text-sm font-medium text-primary hover:text-primary/90"
                >
                  {t('signup.backToLogin')}
                </Link>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
